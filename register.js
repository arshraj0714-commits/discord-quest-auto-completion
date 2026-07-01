const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const BOT_TOKEN = process.env.BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID  = process.env.GUILD_ID;

if (!BOT_TOKEN || !CLIENT_ID) {
  console.error('❌ Missing BOT_TOKEN or CLIENT_ID environment variables!');
  process.exit(1);
}

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

const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);

(async () => {
  try {
    console.log('📝 Registering slash commands…');
    if (GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
      console.log(`✅ Registered ${commands.length} guild commands.`);
    } else {
      await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
      console.log(`✅ Registered ${commands.length} global commands.`);
    }
  } catch (error) {
    console.error('❌ Error:', error);
  }
})();
