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

const BOT_TOKEN = process.env.BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

if (!BOT_TOKEN || !CLIENT_ID) {
  console.error('❌ Missing BOT_TOKEN or CLIENT_ID environment variables!');
  process.exit(1);
}

const pendingLinks = new Map();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages],
  partials: [Partials.Channel, Partials.Message],
});

const commands = [
  new SlashCommandBuilder().setName('link').setDescription('Link your Discord account token'),
  new SlashCommandBuilder().setName('quest').setDescription('View and complete your available Discord quests'),
  new SlashCommandBuilder().setName('quest-all').setDescription('Automatically complete all available quests'),
  new SlashCommandBuilder().setName('unlink').setDescription('Remove your linked Discord token'),
].map((cmd) => cmd.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
  try {
    if (GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
      console.log('✅ Guild commands registered.');
    } else {
      await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
      console.log('✅ Global commands registered.');
    }
  } catch (error) {
    console.error('❌ Command registration error:', error);
  }
}

client.once(Events.ClientReady, async (c) => {
  console.log(`🤖 Bot online: ${c.user.tag}`);
  await registerCommands();
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isChatInputCommand()) {
    switch (interaction.commandName) {
      case 'link': return handleLink(interaction);
      case 'quest': return handleQuest(interaction);
      case 'quest-all': return handleQuestAll(interaction);
      case 'unlink': return handleUnlink(interaction);
    }
  }
  if (interaction.isButton()) return handleQuestButton(interaction);
});

client.on(Events.MessageCreate, async (message) => {
  if (message.guild || message.author.bot) return;

  const pending = pendingLinks.get(message.author.id);
  if (!pending || pending.step !== 'waiting_token') return;

  const token = message.content.trim();
  const user = await validateToken(token);

  if (!user) {
    await message.reply('❌ Invalid token. Please copy the **Authorization** header value from your browser Network tab.');
    return;
  }
  
  // STRICT BOT TOKEN CHECK
  if (user.bot) {
    await message.reply('❌ **BOT TOKEN DETECTED!** Bots do not have quests. You must use your **Discord User Token**. Use `/link` to try again.');
    try { await message.delete(); } catch {}
    return;
  }

  setToken(message.author.id, token);
  pendingLinks.delete(message.author.id);

  await message.reply(
    `✅ **Token linked successfully!**\nAccount: **${user.username}** (${user.id})\nUse \`/quest\` to start completing quests.`
  );

  try { await message.delete(); } catch {}
});

async function handleLink(interaction) {
  const userId = interaction.user.id;
  const existing = getToken(userId);
  if (existing) {
    const user = await validateToken(existing);
    if (user && !user.bot) {
      return interaction.reply({ content: `✅ Already linked as **${user.username}**. Use \`/unlink\` to change.`, ephemeral: true });
    }
  }

  pendingLinks.set(userId, { step: 'waiting_token', timestamp: Date.now() });

  try {
    await interaction.user.send(
      `🔐 **Token Linking**\nPlease send your **Discord USER Token** here.\n\n` +
      `**How to get it:**\n1. Open Discord in your browser\n2. Press **F12** (Dev Tools)\n3. Go to **Network** tab\n4. Click any channel\n5. Click a request to \`discord.com\`\n6. Find \`Authorization\` in Headers\n7. Copy the value\n\n` +
      `⚠️ **WARNING:** Do NOT paste a Bot Token. Bot tokens will be rejected.`
    );
    await interaction.reply({ content: '📬 Check your DMs for instructions.', ephemeral: true });
  } catch {
    pendingLinks.delete(userId);
    await interaction.reply({ content: '❌ I couldn\'t DM you. Enable DMs and try again.', ephemeral: true });
  }
}

async function handleQuest(interaction) {
  const token = getToken(interaction.user.id);
  if (!token) return interaction.reply({ content: '❌ Use `/link` first.', ephemeral: true });

  await interaction.deferReply({ ephemeral: true });
  const user = await validateToken(token);
  
  if (!user || user.bot) {
    deleteToken(interaction.user.id);
    return interaction.editReply('❌ Token invalid or is a Bot Token. Use `/link` to link your USER token.');
  }

  try {
    const quests = await fetchQuests(token);
    if (quests.length === 0) return interaction.editReply('📭 No available quests right now.');

    const embed = new EmbedBuilder()
      .setTitle('🎮 Your Discord Quests')
      .setDescription(`Found **${quests.length}** quest(s). Click a button to complete.`)
      .setColor(0x5865f2)
      .setFooter({ text: `Account: ${user.username}` });

    const buttons = [];
    for (let i = 0; i < Math.min(quests.length, 25); i++) {
      const quest = quests[i];
      const completed = isQuestCompleted(quest);
      embed.addFields({
        name: `${completed ? '✅' : '⬜'} ${i + 1}. ${quest.name || 'Quest'}`,
        value: quest.description || 'No description',
      });
      if (!completed) {
        buttons.push(new ButtonBuilder().setCustomId(`qc_${i}`).setLabel(`Quest ${i + 1}`).setStyle(ButtonStyle.Primary));
      }
    }

    const rows = [];
    for (let i = 0; i < buttons.length; i += 5) {
      rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
    }

    await interaction.editReply({ embeds: [embed], components: rows });
  } catch (error) {
    await interaction.editReply(`❌ Fetch failed: \`${error.message}\``);
  }
}

async function handleQuestButton(interaction) {
  const match = interaction.customId.match(/^qc_(\d+)$/);
  if (!match) return;
  const questIndex = parseInt(match[1]);

  const token = getToken(interaction.user.id);
  if (!token) return interaction.reply({ content: '❌ Use `/link` first.', ephemeral: true });

  await interaction.reply({ content: '⏳ Starting quest...', ephemeral: true });

  try {
    const quests = await fetchQuests(token);
    const quest = quests[questIndex];
    if (!quest) return interaction.editReply('❌ Quest expired.');

    const result = await completeQuest(token, quest, (p) => {
      interaction.editReply(`⏳ Completing **${quest.name}**... Progress: ${p.progress || 0}%`).catch(() => {});
    });

    if (result.success) await interaction.editReply(`✅ **${quest.name}** completed! 🎉`);
    else await interaction.editReply(`❌ Failed: ${result.reason}`);
  } catch (error) {
    await interaction.editReply(`❌ Error: \`${error.message}\``);
  }
}

async function handleQuestAll(interaction) {
  const token = getToken(interaction.user.id);
  if (!token) return interaction.reply({ content: '❌ Use `/link` first.', ephemeral: true });

  await interaction.deferReply({ ephemeral: true });
  const user = await validateToken(token);
  if (!user || user.bot) {
    deleteToken(interaction.user.id);
    return interaction.editReply('❌ Token invalid or is a Bot Token. Use `/link` to link your USER token.');
  }

  try {
    const quests = await fetchQuests(token);
    const incomplete = quests.filter((q) => !isQuestCompleted(q));
    if (incomplete.length === 0) return interaction.editReply('✅ All quests already completed! 🎉');

    await interaction.editReply(`🔄 Completing **${incomplete.length}** quests...`);

    const result = await completeAllQuests(token, (p) => {
      interaction.editReply(`🔄 Completing **${p.current}/${p.total}**: ${p.quest.name || 'Quest'}`).catch(() => {});
    });

    const summary = result.results.map((r, i) => `${r.success ? '✅' : '❌'} ${r.quest?.name || `Quest ${i+1}`}`).join('\n');
    await interaction.editReply(`📊 **Done!** ${result.completed}/${result.total} completed.\n\n${summary}`);
  } catch (error) {
    await interaction.editReply(`❌ Failed: \`${error.message}\``);
  }
}

async function handleUnlink(interaction) {
  deleteToken(interaction.user.id);
  await interaction.reply({ content: '✅ Token removed.', ephemeral: true });
}

client.login(BOT_TOKEN);
