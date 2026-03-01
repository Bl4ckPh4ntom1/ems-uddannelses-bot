import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } from "discord.js";

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;
const SHEETS_SECRET = process.env.SHEETS_SECRET;

if (!DISCORD_TOKEN || !CLIENT_ID || !GUILD_ID || !APPS_SCRIPT_URL || !SHEETS_SECRET) {
  console.error("❌ Missing environment variables");
  process.exit(1);
}

const commands = [
  new SlashCommandBuilder()
    .setName("opret_elev")
    .setDescription("Opret elev i Sheets")
    .addStringOption(o => o.setName("discordnavn").setDescription("Discord navn").setRequired(true))
    .addStringOption(o => o.setName("discordid").setDescription("Discord ID").setRequired(true))
    .addStringOption(o => o.setName("karakter").setDescription("Karakter navn").setRequired(true))
    .addStringOption(o => o.setName("uddannelse").setDescription("Uddannelse").setRequired(true))
    .addStringOption(o => o.setName("vejleder").setDescription("Vejleder").setRequired(true))
    .addStringOption(o => o.setName("thread").setDescription("Discord tråd link").setRequired(true)),

  new SlashCommandBuilder()
    .setName("intro_checkin")
    .setDescription("Intro check-in")
    .addStringOption(o => o.setName("hrid").setDescription("EMS-YYYY-###").setRequired(true))
    .addStringOption(o => o.setName("dato").setDescription("YYYY-MM-DD").setRequired(true))
    .addStringOption(o => o.setName("tid").setDescription("fx 18:00").setRequired(true))
    .addStringOption(o => o.setName("svar").setDescription("Kan/Måske/Kan ikke").setRequired(true)
      .addChoices(
        { name: "Kan", value: "Kan" },
        { name: "Måske", value: "Måske" },
        { name: "Kan ikke", value: "Kan ikke" }
      ))
    .addStringOption(o => o.setName("note").setDescription("Valgfri note").setRequired(false)),

  new SlashCommandBuilder()
    .setName("arkiver")
    .setDescription("Arkiver elev")
    .addStringOption(o => o.setName("hrid").setDescription("EMS-YYYY-###").setRequired(true))
].map(cmd => cmd.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  await rest.put(
    Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
    { body: commands }
  );
  console.log("✅ Slash commands registered");
}

async function callSheets(payload) {
  const response = await fetch(APPS_SCRIPT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  return response.json();
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

client.once("ready", async () => {
  console.log(`🚀 Bot online: ${client.user.tag}`);
  await registerCommands();
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    if (interaction.commandName === "opret_elev") {
      await interaction.deferReply({ ephemeral: true });

      const payload = {
        secret: SHEETS_SECRET,
        action: "create_student",
        discordName: interaction.options.getString("discordnavn", true),
        discordId: interaction.options.getString("discordid", true),
        charName: interaction.options.getString("karakter", true),
        education: interaction.options.getString("uddannelse", true),
        mentor: interaction.options.getString("vejleder", true),
        threadUrl: interaction.options.getString("thread", true),
      };

      const result = await callSheets(payload);

      if (!result.ok) {
        return interaction.editReply(`❌ Sheets fejl: ${result.error}`);
      }

      return interaction.editReply(
        `✅ Elev oprettet: **${result.hrId}**`
      );
    }

    if (interaction.commandName === "intro_checkin") {
      await interaction.deferReply({ ephemeral: true });

      const payload = {
        secret: SHEETS_SECRET,
        action: "intro_checkin",
        discordName: interaction.user.username,
        discordId: interaction.user.id,
        hrId: interaction.options.getString("hrid", true),
        date: interaction.options.getString("dato", true),
        time: interaction.options.getString("tid", true),
        answer: interaction.options.getString("svar", true),
        note: interaction.options.getString("note") || "",
      };

      const result = await callSheets(payload);

      if (!result.ok) {
        return interaction.editReply(`❌ Sheets fejl: ${result.error}`);
      }

      return interaction.editReply("✅ Check-in gemt.");
    }

    if (interaction.commandName === "arkiver") {
      await interaction.deferReply({ ephemeral: true });

      const payload = {
        secret: SHEETS_SECRET,
        action: "archive_student",
        hrId: interaction.options.getString("hrid", true),
      };

      const result = await callSheets(payload);

      if (!result.ok) {
        return interaction.editReply(`❌ Sheets fejl: ${result.error}`);
      }

      return interaction.editReply(`✅ Arkiveret: ${payload.hrId}`);
    }

  } catch (err) {
    console.error(err);
    if (!interaction.replied) {
      await interaction.reply({ content: "❌ Der opstod en fejl.", ephemeral: true });
    }
  }
});

client.login(DISCORD_TOKEN);