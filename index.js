// index.js
const fs = require('fs');
const path = require('path');
const express = require('express');
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  Partials,
} = require('discord.js');

const config = require('./config.json');

// ---------- Simple JSON "database" ----------
const DB_FILE = path.join(__dirname, 'feedback.json');

function loadDb() {
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data.feedback)) data.feedback = [];
    if (!data.allowances) data.allowances = {};
    return data;
  } catch (err) {
    return { feedback: [], allowances: {} };
  }
}

function saveDb(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
}

function addFeedback(entry) {
  const db = loadDb();
  db.feedback.push(entry);
  saveDb(db);
}

function removeFeedbackByMessageId(messageId) {
  const db = loadDb();
  const before = db.feedback.length;
  db.feedback = db.feedback.filter((f) => f.messageId !== messageId);
  const after = db.feedback.length;

  if (after !== before) {
    saveDb(db);
    console.log(`🗑️ Removed feedback linked to messageId ${messageId}`);
  }
}

// ---- Allowances helpers (for !allow + feedback limits) ----
function setAllowance(userId, amount) {
  const db = loadDb();
  if (!db.allowances) db.allowances = {};
  db.allowances[userId] = amount;
  saveDb(db);
}

function getAllowance(userId) {
  const db = loadDb();
  if (!db.allowances) db.allowances = {};
  return db.allowances[userId] || 0;
}

function decrementAllowance(userId) {
  const db = loadDb();
  if (!db.allowances) db.allowances = {};
  if (!db.allowances[userId]) db.allowances[userId] = 0;

  if (db.allowances[userId] > 0) {
    db.allowances[userId] -= 1;
    saveDb(db);
  }
  return db.allowances[userId];
}

// ---------- Express (website) ----------
const app = express();
app.use(express.json());
app.use(express.static('public')); // serves public/index.html, feedback.html, etc.

// API: website gets feedback history
app.get('/api/feedback-logs', (req, res) => {
  try {
    const db = loadDb();
    const all = db.feedback || [];
    const sorted = [...all].reverse(); // newest first
    res.json(sorted);
  } catch (err) {
    console.error('Error reading feedback logs:', err);
    res.status(500).json({ error: 'Failed to load feedback logs' });
  }
});

// optional status endpoint
app.get('/api/status', (req, res) => {
  res.json({
    ok: true,
    message: 'Feedback API running',
  });
});

// Start web server
const port = config.port || 3000;
app.listen(port, () => {
  console.log(`🌐 Website running on http://localhost:${port}`);
});

// ---------- Discord bot ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message, Partials.Channel],
});

client.once('ready', () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
});

// Message commands
client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;

  const rawContent = message.content.trim();
  const content = rawContent.toLowerCase();
  const requiredRoleId = config.requiredRoleId;
  const member = message.member;

  // Simple ping
  if (content === 'ping') {
    return message.reply('Pong! 🏓');
  }

  // ---- !allow @user amount ----
  if (content.startsWith('!allow')) {
    // Try to delete the trigger message immediately
    message.delete().catch(() => {});

    // Only staff (requiredRoleId) can use this
    if (!member.roles.cache.has(requiredRoleId)) {
      const reply = await message.channel.send("❌ You don't have permission to use this command.");
      setTimeout(() => reply.delete().catch(() => {}), 5000);
      return;
    }

    const args = rawContent.split(/\s+/);
    const target = message.mentions.members.first();

    if (!target || args.length < 3) {
      const reply = await message.channel.send('Usage: `!allow @user <amount>`');
      setTimeout(() => reply.delete().catch(() => {}), 5000);
      return;
    }

    const amount = parseInt(args[2], 10);
    if (isNaN(amount) || amount < 1) {
      const reply = await message.channel.send('❌ Amount must be a positive number.');
      setTimeout(() => reply.delete().catch(() => {}), 5000);
      return;
    }

    setAllowance(target.id, amount);

    const response = await message.channel.send(
        `✅ **${target.user.tag}** is now allowed to submit **${amount}** feedback(s).`
    );

    // Auto-delete the bot’s message after 1 seconds
    setTimeout(() => response.delete().catch(() => {}), 1000);

    return;
  }

  // ---- !feedback (panel) ----
  if (content === '!feedback') {
    // Only staff can spawn the panel (like before)
    if (!member.roles.cache.has(requiredRoleId)) {
      const reply = await message.reply("❌ You don't have permission to use this command.");
      setTimeout(() => reply.delete().catch(() => {}), 5000);
      return;
    }

    try {
      // Delete the trigger message
      await message.delete().catch(() => {});

      // Embed with button to open feedback form (modal)
      const embed = new EmbedBuilder()
        .setTitle('Feedback Panel')
        .setDescription(
          'Click the button below to open a form and submit your feedback.\n\nOnly users who have been allowed via `!allow` can submit feedback.'
        )
        .setColor(0x5865f2)
        .setFooter({ text: `Requested by ${message.author.tag}` })
        .setTimestamp();

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('feedback_create')
          .setLabel('Create Feedback')
          .setStyle(ButtonStyle.Primary)
      );

      await message.channel.send({ embeds: [embed], components: [row] });
    } catch (err) {
      console.error('Error sending feedback panel:', err);
      message.channel
        .send('⚠️ Something went wrong while creating the feedback panel.')
        .catch(() => {});
    }
  }
});

// Interactions: button + modal
client.on('interactionCreate', async (interaction) => {
  // Button click: open modal (only if user has allowance)
  if (interaction.isButton()) {
    if (interaction.customId === 'feedback_create') {
      const remaining = getAllowance(interaction.user.id);

      if (remaining <= 0) {
        return interaction.reply({
          content:
            '❌ You are not allowed to submit feedback, or you have used all your available feedbacks.\nAsk a staff member to use `!allow @you <amount>`.',
          ephemeral: true,
        });
      }

      const modal = new ModalBuilder()
        .setCustomId('feedback_modal')
        .setTitle('Create Feedback');

      const ratingInput = new TextInputBuilder()
        .setCustomId('rating_input')
        .setLabel('Rating (1–5)')
        .setStyle(TextInputStyle.Short)
        .setMinLength(1)
        .setMaxLength(1)
        .setRequired(true);

      const commentInput = new TextInputBuilder()
        .setCustomId('comment_input')
        .setLabel('Comment (optional)')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false);

      const row1 = new ActionRowBuilder().addComponents(ratingInput);
      const row2 = new ActionRowBuilder().addComponents(commentInput);

      modal.addComponents(row1, row2);

      await interaction.showModal(modal);
    }
  }

  // Modal submit: save feedback AND send embed to log channel
  if (interaction.isModalSubmit()) {
    if (interaction.customId === 'feedback_modal') {
      const ratingStr = interaction.fields.getTextInputValue('rating_input');
      const comment = interaction.fields.getTextInputValue('comment_input') || '';

      const rating = parseInt(ratingStr, 10);

      if (isNaN(rating) || rating < 1 || rating > 5) {
        return interaction.reply({
          content: '❌ Rating must be a number from **1** to **5**.',
          ephemeral: true,
        });
      }

      const user = interaction.user;

      // Double-check allowance at submit time
      const remaining = getAllowance(user.id);
      if (remaining <= 0) {
        return interaction.reply({
          content:
            '❌ You are not allowed to submit feedback, or you have used all your available feedbacks.\nAsk a staff member to use `!allow @you <amount>`.',
          ephemeral: true,
        });
      }

      try {
        // Send feedback embed to the log channel
        const logChannelId = config.channelId;
        const logChannel = await client.channels.fetch(logChannelId);

        if (!logChannel || !logChannel.isTextBased()) {
          console.error('Feedback log channel not found or not text-based');
        }

        const feedbackEmbed = new EmbedBuilder()
          .setTitle('New Feedback Submitted')
          .setColor(0x22c55e)
          .addFields(
            { name: 'User', value: `${user.username} (ID: ${user.id})`, inline: false },
            { name: 'Rating', value: `${rating}/5 ⭐`, inline: true },
            { name: 'Comment', value: comment || '*No comment provided*', inline: false }
          )
          .setTimestamp();

        let sentMessage = null;
        if (logChannel && logChannel.isTextBased()) {
          sentMessage = await logChannel.send({ embeds: [feedbackEmbed] });
        }

        // Build entry for the DB. Link it to the Discord message if sent.
        const entry = {
          userId: user.id,
          username: user.username,
          rating,
          comment,
          createdAt: new Date().toISOString(),
          messageId: sentMessage ? sentMessage.id : null,
          channelId: sentMessage ? sentMessage.channelId : null,
        };

        addFeedback(entry);

        // Decrease allowance
        const left = decrementAllowance(user.id);

        return interaction.reply({
          content: `✅ Your feedback has been submitted. Thank you!\nYou have **${left}** feedback(s) remaining.`,
          ephemeral: true,
        });
      } catch (err) {
        console.error('Error saving/sending feedback:', err);
        return interaction.reply({
          content: '⚠️ Something went wrong while saving your feedback.',
          ephemeral: true,
        });
      }
    }
  }
});

// When a feedback message is deleted in the log channel, remove it from the DB
client.on('messageDelete', async (message) => {
  try {
    if (!message || !message.id) return;
    if (!message.channelId && !message.channel) return;

    const channelId =
      message.channelId || (message.channel ? message.channel.id : null);

    if (!channelId) return;
    if (channelId !== config.channelId) return;

    removeFeedbackByMessageId(message.id);
  } catch (err) {
    console.error('Error handling messageDelete:', err);
  }
});

// Login bot
client.login(config.token);
