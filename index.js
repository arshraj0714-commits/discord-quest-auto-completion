const {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  SlashCommandBuilder,
  REST,
  Routes,
} = require('discord.js');

const { getToken, setToken, deleteToken } = require('./storage');
const {
  fetchQuests,
  completeQuest,
  completeAllQuests,
  validateToken,
  isQuestCompleted,
  getQuestProgress,
} = require('./questHandler');

// ─── Config ─────────────────────────────────────────────────

const BOT_TOKEN = process.env.BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID; // optional — for instant guild command registration

if (!BOT_TOKEN || !CLIENT_ID) {
  console.error('❌ Missing BOT_TOKEN or CLIENT_ID environment variables!');
  process.exit(1);
}

// ─── State ──────────────────────────────────────────────────

// Tracks users who are in the middle of linking their token
const pendingLinks = new Map(); // userId -> { step, timestamp }

// ─── Client ─────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message],
});

// ─── Slash Commands ─────────────────────────────────────────

const commands = [
  new SlashCommandBuilder()
    .setName('link')
    .setDescription('Link your Discord account token to complete quests'),
  new SlashCommandBuilder()
    .setName('quest')
    .setDescription('View and complete your available Discord quests'),
  new SlashCommandBuilder()
    .setName('quest-all')
    .setDescription('Automatically complete all available quests'),
  new SlashCommandBuilder()
    .setName('unlink')
    .setDescription('Remove your linked Discord token'),
].map((cmd) => cmd.toJSON());

// ─── Register Commands ──────────────────────────────────────

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
  try {
    console.log('📝 Registering slash commands…');
    if (GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
        body: commands,
      });
      console.log('✅ Guild commands registered.');
    } else {
      await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
      console.log('✅ Global commands registered (may take up to 1h to appear).');
    }
  } catch (error) {
    console.error('❌ Command registration error:', error);
  }
}

// ─── Events ─────────────────────────────────────────────────

client.once(Events.ClientReady, async (c) => {
  console.log(`🤖 Bot online: ${c.user.tag}`);
  await registerCommands();
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isChatInputCommand()) {
    switch (interaction.commandName) {
      case 'link':
        return handleLink(interaction);
      case 'quest':
        return handleQuest(interaction);
      case 'quest-all':
        return handleQuestAll(interaction);
      case 'unlink':
        return handleUnlink(interaction);
    }
  }
  if (interaction.isButton()) {
    return handleQuestButton(interaction);
  }
});

// DM message handler — for receiving the token
client.on(Events.MessageCreate, async (message) => {
  if (message.guild) return; // DMs only
  if (message.author.bot) return;

  const pending = pendingLinks.get(message.author.id);
  if (!pending || pending.step !== 'waiting_token') return;

  const token = message.content.trim();
  const user = await validateToken(token);

  if (!user) {
    await message.reply(
      '❌ Invalid token. Please double-check you copied the **Authorization** header value correctly and try again.'
    );
    return;
  }

  setToken(message.author.id, token);
  pendingLinks.delete(message.author.id);

  await message.reply(
    `✅ **Token linked successfully!**\n` +
      `Account: **${user.username}** (${user.id})\n\n` +
      `You can now use \`/quest\` and \`/quest-all\` to complete your Discord quests.`
  );

  // Delete the original token message for security
  try {
    await message.delete();
  } catch {
    /* ignore */
  }
});

// ─── Command Handlers ───────────────────────────────────────

async function handleLink(interaction) {
  const userId = interaction.user.id;

  // Check if already linked
  const existing = getToken(userId);
  if (existing) {
    const user = await validateToken(existing);
    if (user) {
      return interaction.reply({
        content: `✅ You are already linked as **${user.username}**.\nUse \`/unlink\` first if you want to link a different account.`,
        ephemeral: true,
      });
    }
  }

  pendingLinks.set(userId, { step: 'waiting_token', timestamp: Date.now() });

  try {
    await interaction.user.send(
      `🔐 **Token Linking**\n\n` +
        `Please send your Discord **user token** in this DM.\n\n` +
        `**How to get your token:**\n` +
        `1. Open Discord in your **browser** (Chrome / Firefox / Edge)\n` +
        `2. Press **F12** to open Developer Tools\n` +
        `3. Go to the **Network** tab\n` +
        `4. Refresh the page or click any channel\n` +
        `5. Click any request to \`discord.com\`\n` +
        `6. In **Headers**, find \`Authorization\`\n` +
        `7. Copy the value — that's your token\n\n` +
        `⚠️ **WARNING:** Using a user token is against Discord's Terms of Service ` +
        `and may result in account termination. **Use at your own risk!**\n\n` +
        `Send your token now 👇`
    );

    await interaction.reply({
      content: '📬 Check your DMs! I\'ve sent you instructions on how to link your token.',
      ephemeral: true,
    });
  } catch {
    pendingLinks.delete(userId);
    await interaction.reply({
      content:
        '❌ I couldn\'t send you a DM. Please enable DMs from server members and try again.',
      ephemeral: true,
    });
  }
}

async function handleQuest(interaction) {
  const token = getToken(interaction.user.id);
  if (!token) {
    return interaction.reply({
      content: '❌ You haven\'t linked your token yet. Use `/link` to get started.',
      ephemeral: true,
    });
  }

  await interaction.deferReply({ ephemeral: true });

  // Validate token
  const user = await validateToken(token);
  if (!user) {
    deleteToken(interaction.user.id);
    return interaction.editReply(
      '❌ Your token is invalid or expired. Please use `/link` to re-link your account.'
    );
  }

  try {
    const quests = await fetchQuests(token);

    if (quests.length === 0) {
      return interaction.editReply('📭 You have no available quests right now. Check back later!');
    }

    const embed = new EmbedBuilder()
      .setTitle('🎮 Your Discord Quests')
      .setDescription(
        `Found **${quests.length}** quest(s). Click a button below to auto-complete a quest.\n\n` +
          `✅ = Completed  |  ⬜ = Incomplete`
      )
      .setColor(0x5865f2)
      .setTimestamp()
      .setFooter({ text: `Account: ${user.username}` });

    const buttons = [];
    const MAX_BUTTONS = 25; // Discord limit (5 rows × 5 buttons)

    for (let i = 0; i < Math.min(quests.length, MAX_BUTTONS); i++) {
      const quest = quests[i];
      const completed = isQuestCompleted(quest);
      const progress = getQuestProgress(quest);
      const status = completed ? '✅' : '⬜';

      embed.addFields({
        name: `${status} ${i + 1}. ${quest.name || 'Unnamed Quest'}`,
        value:
          (quest.description || 'No description available.') +
          (completed ? '\n`Status: Completed`' : `\n`Progress: ${progress || 0}%`),
        inline: false,
      });

      if (!completed) {
        buttons.push(
          new ButtonBuilder()
            .setCustomId(`qc_${i}`)
            .setLabel(`Quest ${i + 1}`)
            .setStyle(ButtonStyle.Primary)
        );
      }
    }

    const rows = [];
    for (let i = 0; i < buttons.length; i += 5) {
      rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
    }

    await interaction.editReply({
      embeds: [embed],
      components: rows.length > 0 ? rows : [],
    });
  } catch (error) {
    console.error('Quest fetch error:', error);
    await interaction.editReply(`❌ Failed to fetch quests: \`${error.message}\``);
  }
}

async function handleQuestButton(interaction) {
  const match = interaction.customId.match(/^qc_(\d+)$/);
  if (!match) return;
  const questIndex = parseInt(match[1]);

  const token = getToken(interaction.user.id);
  if (!token) {
    return interaction.reply({
      content: '❌ Token not found. Use `/link` to link your token.',
      ephemeral: true,
    });
  }

  await interaction.reply({
    content: '⏳ Starting quest completion… This may take up to **17 minutes**. I\'ll update you here.',
    ephemeral: true,
  });

  try {
    const quests = await fetchQuests(token);
    const quest = quests[questIndex];

    if (!quest) {
      return interaction.editReply('❌ Quest not found. It may have expired. Use `/quest` to refresh.');
    }

    if (isQuestCompleted(quest)) {
      return interaction.editReply(`✅ **${quest.name}** is already completed!`);
    }

    const result = await completeQuest(token, quest, (p) => {
      const pct = Math.min(100, Math.round((p.elapsed / p.duration) * 100));
      interaction
        .editReply(
          `⏳ Completing **${quest.name}**…\n` +
            `Elapsed: ${pct}% | Quest Progress: ${p.progress || 0}%`
        )
        .catch(() => {});
    });

    if (result.success) {
      await interaction.editReply(`✅ Quest **${quest.name}** completed successfully! 🎉`);
    } else {
      await interaction.editReply(
        `❌ Failed to complete **${quest.name}**: ${result.reason}`
      );
    }
  } catch (error) {
    console.error('Quest button error:', error);
    await interaction.editReply(`❌ Error: \`${error.message}\``);
  }
}

async function handleQuestAll(interaction) {
  const token = getToken(interaction.user.id);
  if (!token) {
    return interaction.reply({
      content: '❌ You haven\'t linked your token yet. Use `/link` to get started.',
      ephemeral: true,
    });
  }

  await interaction.deferReply({ ephemeral: true });

  const user = await validateToken(token);
  if (!user) {
    deleteToken(interaction.user.id);
    return interaction.editReply(
      '❌ Your token is invalid or expired. Please use `/link` to re-link.'
    );
  }

  try {
    const quests = await fetchQuests(token);
    const incomplete = quests.filter((q) => !isQuestCompleted(q));

    if (incomplete.length === 0) {
      return interaction.editReply('✅ All your quests are already completed! 🎉');
    }

    await interaction.editReply(
      `🔄 Starting completion of **${incomplete.length}** quest(s)…\n` +
        `This may take a while. Each quest takes ~15 minutes.`
    );

    const result = await completeAllQuests(token, (p) => {
      interaction
        .editReply(
          `🔄 Completing quests… (**${p.current}/${p.total}**)\n` +
            `Current: **${p.quest.name || 'Unnamed'}**`
        )
        .catch(() => {});
    });

    const summary = result.results
      .map((r, i) => {
        const icon = r.success ? '✅' : '❌';
        const name = r.quest?.name || `Quest ${i + 1}`;
        const reason = r.reason && !r.success ? ` — ${r.reason}` : '';
        return `${icon} ${name}${reason}`;
      })
      .join('\n');

    await interaction.editReply(
      `📊 **Quest Completion Summary**\n` +
        `Completed **${result.completed}** / **${result.total}** quests.\n\n${summary}`
    );
  } catch (error) {
    console.error('Quest-all error:', error);
    await interaction.editReply(`❌ Failed: \`${error.message}\``);
  }
}

async function handleUnlink(interaction) {
  deleteToken(interaction.user.id);
  await interaction.reply({
    content: '✅ Your token has been removed from storage.',
    ephemeral: true,
  });
}

// ─── Start ──────────────────────────────────────────────────

client.login(BOT_TOKEN);
