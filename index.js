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
  StringSelectMenuBuilder,
  ChannelType,
  PermissionFlagsBits,
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

// ---------- Ticket system config ----------
const TICKET_CATEGORY_ID = '1447986703250882580'; // category where tickets will be created
const STAFF_ROLE_ID = config.requiredRoleId; // reuse your staff role

// Ticket types used in the select menu
const TICKET_TYPES = [
  { label: 'General Support', value: 'general', emoji: '❔' },
  { label: 'Purchase / Order Issue', value: 'purchase', emoji: '💳' },
  { label: 'Bug / Technical Issue', value: 'bug', emoji: '🐞' },
  { label: 'Other Question', value: 'other', emoji: '📩' },
];

function prettyTicketLabel(value) {
  const found = TICKET_TYPES.find((t) => t.value === value);
  return found ? found.label : value;
}

// ---------- Embed helper (uses config.color & thumbnail) ----------
function createServerEmbed() {
  const embed = new EmbedBuilder()
    .setColor(config.color || '#0362fc')
    .setTimestamp();

  if (config.thumbnail) {
    embed.setThumbnail(config.thumbnail);
    embed.setFooter({ text: 'Support System', iconURL: config.thumbnail });
  }

  return embed;
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
const port = process.env.PORT || config.port || 3000;
app.listen(port, () => {
  console.log(`🌐 Website running on http://localhost:${port}`);
});

// ---------- Discord bot ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildPresences, // added to read clientStatus (mobile/desktop/web)
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
      const reply = await message.channel.send(
        "❌ You don't have permission to use this command."
      );
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
      const reply = await message.channel.send(
        '❌ Amount must be a positive number.'
      );
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
      const reply = await message.reply(
        "❌ You don't have permission to use this command."
      );
      setTimeout(() => reply.delete().catch(() => {}), 5000);
      return;
    }

    try {
      // Delete the trigger message
      await message.delete().catch(() => {});

      const embed = createServerEmbed()
        .setTitle('Feedback Panel')
        .setDescription(
          'Click the button below to open a form and submit your feedback.\n\nOnly users who have been allowed via `!allow` can submit feedback.'
        );

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

  // ---- !ticketpanel (create ticket select menu) ----
  if (content === '!ticketpanel') {
    // Only staff can spawn the ticket panel
    if (!member.roles.cache.has(requiredRoleId)) {
      const reply = await message.reply(
        "❌ You don't have permission to use this command."
      );
      setTimeout(() => reply.delete().catch(() => {}), 5000);
      return;
    }

    try {
      await message.delete().catch(() => {});

      const embed = createServerEmbed()
        .setTitle('Support Tickets')
        .setDescription(
          'Need help? Select a category from the menu below to open a private ticket with our team.\n\nAdmins will be able to **notify you via DM** and **close your ticket** from inside the channel.'
        );

      const selectMenu = new StringSelectMenuBuilder()
        .setCustomId('ticket_select')
        .setPlaceholder('Choose a ticket type...')
        .addOptions(
          TICKET_TYPES.map((t) => ({
            label: t.label,
            value: t.value,
            emoji: t.emoji,
          }))
        );

      const row = new ActionRowBuilder().addComponents(selectMenu);

      await message.channel.send({ embeds: [embed], components: [row] });
    } catch (err) {
      console.error('Error sending ticket panel:', err);
      message.channel
        .send('⚠️ Something went wrong while creating the ticket panel.')
        .catch(() => {});
    }
  }
});

// Interactions: button + modal + select menu
client.on('interactionCreate', async (interaction) => {
  // ---------------- BUTTONS ----------------
  if (interaction.isButton()) {
    // Feedback panel button
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

      return interaction.showModal(modal);
    }

    // Ticket notify button
    if (interaction.customId === 'ticket_notify') {
      const member = interaction.member;
      if (!member?.roles?.cache?.has(STAFF_ROLE_ID)) {
        return interaction.reply({
          content: "❌ You don't have permission to use this button.",
          ephemeral: true,
        });
      }

      const topic = interaction.channel.topic || '';
      const match = topic.match(/UserID:(\d{17,19})/);
      if (!match) {
        return interaction.reply({
          content: '⚠️ Could not find the ticket owner (no user ID in topic).',
          ephemeral: true,
        });
      }

      const userId = match[1];
      let user;
      try {
        user = await client.users.fetch(userId);
      } catch (err) {
        console.error('Error fetching user for notify:', err);
      }

      if (!user) {
        return interaction.reply({
          content: '⚠️ Failed to fetch the user to notify.',
          ephemeral: true,
        });
      }

      const dmEmbed = createServerEmbed()
        .setTitle('🔔 Ticket Notification')
        .setDescription(
          `Hey ${user.username},\n\n` +
          `You currently have an **open ticket** on **${interaction.guild.name}**.\n` +
          `A staff member has pinged you to check the ticket channel.\n\n` +
          `> Please open Discord and visit the server to continue the conversation.`
        );

      try {
        await user.send({ embeds: [dmEmbed] });
        await interaction.reply({
          content: `✅ Successfully notified ${user.tag} via DM.`,
          ephemeral: true,
        });
      } catch (err) {
        console.error('Error sending DM:', err);
        await interaction.reply({
          content: '⚠️ I could not DM this user. They might have DMs disabled.',
          ephemeral: true,
        });
      }
      return;
    }

    // Ticket close button
    if (interaction.customId === 'ticket_close') {
      const member = interaction.member;
      if (!member?.roles?.cache?.has(STAFF_ROLE_ID)) {
        return interaction.reply({
          content: "❌ You don't have permission to close this ticket.",
          ephemeral: true,
        });
      }

      const topic = interaction.channel.topic || '';
      const match = topic.match(/UserID:(\d{17,19})/);
      let user = null;

      if (match) {
        try {
          user = await client.users.fetch(match[1]);
        } catch (err) {
          console.error('Error fetching user for close:', err);
        }
      }

      // Optional DM to user telling them it was closed
      if (user) {
        const dmEmbed = createServerEmbed()
          .setTitle('🔒 Ticket Closed')
          .setDescription(
            `Your ticket on **${interaction.guild.name}** has been **closed** by a staff member.\n\n` +
            `If you need more help, feel free to open a new ticket at any time.`
          );
        user.send({ embeds: [dmEmbed] }).catch(() => {});
      }

      const closeEmbed = createServerEmbed()
        .setTitle('🔒 Ticket Closing')
        .setDescription('This ticket will be deleted in a few seconds...');

      await interaction.reply({
        embeds: [closeEmbed],
        ephemeral: true,
      });

      setTimeout(() => {
        interaction.channel.delete().catch((err) =>
          console.error('Error deleting ticket channel:', err)
        );
      }, 3000);

      return;
    }
  }

  // ---------------- SELECT MENU (ticket creation) ----------------
  if (interaction.isStringSelectMenu()) {
    if (interaction.customId === 'ticket_select') {
      const guild = interaction.guild;
      if (!guild) {
        return interaction.reply({
          content: '❌ This can only be used inside a server.',
          ephemeral: true,
        });
      }

      const selection = interaction.values[0];
      const category = guild.channels.cache.get(TICKET_CATEGORY_ID);

      if (!category || category.type !== ChannelType.GuildCategory) {
        return interaction.reply({
          content:
            '⚠️ Ticket category is not configured correctly. Please contact an administrator.',
          ephemeral: true,
        });
      }

      // Optional: one active ticket per user in this category
      const existing = guild.channels.cache.find(
        (ch) =>
          ch.parentId === TICKET_CATEGORY_ID &&
          ch.topic &&
          ch.topic.includes(`UserID:${interaction.user.id}`)
      );

      if (existing) {
        return interaction.reply({
          content: `⚠️ You already have an open ticket: ${existing}.`,
          ephemeral: true,
        });
      }

      // Safe channel name
      const baseName =
        interaction.user.username
          .toLowerCase()
          .replace(/[^a-z0-9]/g, '') || 'user';
      const channelName = `ticket-${baseName}`.slice(0, 90);

      try {
        const newChannel = await guild.channels.create({
          name: channelName,
          type: ChannelType.GuildText,
          parent: TICKET_CATEGORY_ID,
          topic: `Ticket for ${interaction.user.tag} (UserID:${interaction.user.id}) | Type: ${prettyTicketLabel(
            selection
          )}`,
          permissionOverwrites: [
            {
              id: guild.id,
              deny: [PermissionFlagsBits.ViewChannel],
            },
            {
              id: interaction.user.id,
              allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ReadMessageHistory,
              ],
            },
            {
              id: STAFF_ROLE_ID,
              allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ReadMessageHistory,
              ],
            },
          ],
        });

        const ticketEmbed = createServerEmbed()
          .setTitle('🎫 New Support Ticket')
          .setDescription(
            `Hello ${interaction.user}, thanks for contacting support!\n\n` +
              `**Ticket Type:** ${prettyTicketLabel(selection)}\n` +
              'A staff member will be with you shortly.\n\n' +
              'Please describe your issue in as much detail as possible.\n\n' +
              '> Staff can press **Notify User** to DM you, or **Close Ticket** to end the ticket.'
          )
          .addFields(
            {
              name: 'Opened By',
              value: `${interaction.user} (${interaction.user.tag})`,
              inline: false,
            },
            {
              name: 'Type',
              value: prettyTicketLabel(selection),
              inline: true,
            }
          );

        const buttonsRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('ticket_notify')
            .setLabel('Notify User')
            .setEmoji('🔔')
            .setStyle(ButtonStyle.Primary),
          new ButtonBuilder()
            .setCustomId('ticket_close')
            .setLabel('Close Ticket')
            .setEmoji('🔒')
            .setStyle(ButtonStyle.Danger)
        );

        await newChannel.send({
          content: `<@${interaction.user.id}> <@&${STAFF_ROLE_ID}>`,
          embeds: [ticketEmbed],
          components: [buttonsRow],
        });

        await interaction.reply({
          content: `✅ Your ticket has been created: ${newChannel}`,
          ephemeral: true,
        });
      } catch (err) {
        console.error('Error creating ticket channel:', err);
        return interaction.reply({
          content:
            '⚠️ Something went wrong while creating your ticket. Please contact staff.',
          ephemeral: true,
        });
      }
    }
  }

  // ---------------- MODALS (feedback) ----------------
  if (interaction.isModalSubmit()) {
    if (interaction.customId === 'feedback_modal') {
      const ratingStr = interaction.fields.getTextInputValue('rating_input');
      const comment =
        interaction.fields.getTextInputValue('comment_input') || '';

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
        // 🔍 Detect which platform the user is active on
        let platform = 'Unknown';

        if (interaction.guild) {
          const member = await interaction.guild.members
            .fetch(user.id)
            .catch(() => null);

          const clientStatus = member?.presence?.clientStatus;
          if (clientStatus) {
            if (clientStatus.mobile) platform = 'Mobile';
            else if (clientStatus.desktop) platform = 'Desktop';
            else if (clientStatus.web) platform = 'Web';
          }
        }

        // Send feedback embed to the log channel
        const logChannelId = config.channelId;
        const logChannel = await client.channels.fetch(logChannelId);

        const feedbackEmbed = createServerEmbed()
          .setTitle('📝 New Feedback Submitted')
          .addFields(
            {
              name: 'User',
              value: `${user.username} (ID: ${user.id})`,
              inline: false,
            },
            { name: 'Rating', value: `${rating}/5 ⭐`, inline: true },
            { name: 'Platform', value: platform, inline: true },
            {
              name: 'Comment',
              value: comment || '*No comment provided*',
              inline: false,
            }
          );

        let sentMessage = null;
        if (logChannel && logChannel.isTextBased()) {
          sentMessage = await logChannel.send({ embeds: [feedbackEmbed] });
        } else {
          console.error('Feedback log channel not found or not text-based');
        }

        // Build entry for the DB. Link it to the Discord message if sent.
        const entry = {
          userId: user.id,
          username: user.username,
          rating,
          comment,
          platform,
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
client.login(config.token || process.env.token);
