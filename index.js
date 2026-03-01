import {
  Client, GatewayIntentBits,
  REST, Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle
} from "discord.js";

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;
const SHEETS_SECRET = process.env.SHEETS_SECRET;

const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID; // logkanal id
const HR_ROLE_IDS = (process.env.HR_ROLE_IDS || "")
  .split(",").map(s => s.trim()).filter(Boolean);

if (!DISCORD_TOKEN || !CLIENT_ID || !GUILD_ID || !APPS_SCRIPT_URL || !SHEETS_SECRET) {
  console.error("❌ Missing env vars. Need DISCORD_TOKEN, CLIENT_ID, GUILD_ID, APPS_SCRIPT_URL, SHEETS_SECRET.");
  process.exit(1);
}

const EDU_CHOICES = [
  { name: "Studerende → Læge", value: "Studerende → Læge" },
  { name: "Læge → Akutlæge", value: "Læge → Akutlæge" },
  { name: "Læge → Psykiater", value: "Læge → Psykiater" },
  { name: "Behandler-elev → Behandler", value: "Behandler-elev → Behandler" },
  { name: "Læge-studerende → Læge", value: "Læge-studerende → Læge" },
];

function isHR(interaction) {
  if (!HR_ROLE_IDS.length) return true; // hvis du ikke har sat HR_ROLE_IDS endnu, tillad (midlertidigt)
  const roles = interaction.member?.roles?.cache;
  if (!roles) return false;
  return HR_ROLE_IDS.some(id => roles.has(id));
}

async function callSheets(payload) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const res = await fetch(APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    const text = await res.text();
    let json;
    try { json = JSON.parse(text); }
    catch { throw new Error(`Apps Script gav ikke JSON (status ${res.status}): ${text.slice(0, 200)}`); }

    return json;
  } finally {
    clearTimeout(timeout);
  }
}

async function logToDiscord(client, msg) {
  if (!LOG_CHANNEL_ID) return;
  try {
    const ch = await client.channels.fetch(LOG_CHANNEL_ID);
    if (ch) await ch.send({ content: msg.slice(0, 1900) });
  } catch (_) {}
}

// Parse thread/channel link (valgfrit, men bruges til auto-post)
function parseDiscordLink(link) {
  // https://discord.com/channels/<guildId>/<channelId>/<messageId>
  const m = String(link || "").match(/discord\.com\/channels\/(\d+)\/(\d+)(?:\/(\d+))?/);
  if (!m) return null;
  return { guildId: m[1], channelId: m[2], messageId: m[3] || null };
}

function kravEmbed(hrId, edu, labels, checks, done, total) {
  const lines = labels.map((l, i) => `${checks[i] ? "✅" : "⬜"} **${i + 1}.** ${l}`);
  return new EmbedBuilder()
    .setTitle(`Krav — ${hrId}`)
    .setDescription(lines.join("\n"))
    .addFields(
      { name: "Uddannelse", value: edu || "—", inline: true },
      { name: "Status", value: `${done}/${total}`, inline: true }
    );
}

function kravButtons(hrId, checks) {
  const row1 = new ActionRowBuilder();
  for (let i = 1; i <= 3; i++) {
    row1.addComponents(
      new ButtonBuilder()
        .setCustomId(`krav:${hrId}:${i}`)
        .setLabel(`${i}`)
        .setStyle(checks[i - 1] ? ButtonStyle.Success : ButtonStyle.Secondary)
    );
  }
  const row2 = new ActionRowBuilder();
  for (let i = 4; i <= 6; i++) {
    row2.addComponents(
      new ButtonBuilder()
        .setCustomId(`krav:${hrId}:${i}`)
        .setLabel(`${i}`)
        .setStyle(checks[i - 1] ? ButtonStyle.Success : ButtonStyle.Secondary)
    );
  }
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`krav_refresh:${hrId}`).setLabel("🔄 Refresh").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`krav_archive:${hrId}`).setLabel("📦 Arkiver").setStyle(ButtonStyle.Danger),
  );
  return [row1, row2, row3];
}

const commands = [
  new SlashCommandBuilder().setName("ping").setDescription("Tester bot ↔ Sheets"),

  new SlashCommandBuilder()
    .setName("opret_elev")
    .setDescription("Opret elev i Sheets + auto-checkliste")
    .addStringOption(o => o.setName("discordnavn").setDescription("Elevens Discord navn").setRequired(true))
    .addStringOption(o => o.setName("discordid").setDescription("Elevens Discord ID").setRequired(true))
    .addStringOption(o => o.setName("karakter").setDescription("Karakter navn").setRequired(true))
    .addStringOption(o => o.setName("uddannelse").setDescription("Uddannelse").setRequired(true)
      .addChoices(...EDU_CHOICES))
    .addStringOption(o => o.setName("vejleder").setDescription("Vejleder").setRequired(true))
    .addStringOption(o => o.setName("threadlink").setDescription("Discord tråd/kanal link (optional)").setRequired(false)),

  new SlashCommandBuilder()
    .setName("find_elev")
    .setDescription("Søg elev (navn/hrid/discord/uddannelse)")
    .addStringOption(o => o.setName("query").setDescription("Søg").setRequired(true)),

  new SlashCommandBuilder()
    .setName("elev")
    .setDescription("Vis elevkort via HR-ID")
    .addStringOption(o => o.setName("hrid").setDescription("EMS-YYYY-###").setRequired(true)),

  new SlashCommandBuilder()
    .setName("set_status")
    .setDescription("Sæt status på elev (HR-only)")
    .addStringOption(o => o.setName("hrid").setDescription("EMS-YYYY-###").setRequired(true))
    .addStringOption(o => o.setName("status").setDescription("Ny status").setRequired(true)
      .addChoices(
        { name: "Aktiv", value: "Aktiv" },
        { name: "Færdig", value: "Færdig" },
        { name: "Arkiveret", value: "Arkiveret" }
      )),

  new SlashCommandBuilder()
    .setName("krav")
    .setDescription("Vis krav/progress (med knapper)")
    .addStringOption(o => o.setName("hrid").setDescription("EMS-YYYY-###").setRequired(true)),

  new SlashCommandBuilder()
    .setName("toggle_krav")
    .setDescription("Toggle krav 1-6 (HR-only)")
    .addStringOption(o => o.setName("hrid").setDescription("EMS-YYYY-###").setRequired(true))
    .addIntegerOption(o => o.setName("nr").setDescription("1-6").setRequired(true)
      .addChoices(
        {name:"1",value:1},{name:"2",value:2},{name:"3",value:3},
        {name:"4",value:4},{name:"5",value:5},{name:"6",value:6}
      )),

  new SlashCommandBuilder()
    .setName("intro_checkin")
    .setDescription("Gem intro check-in i Sheets")
    .addStringOption(o => o.setName("hrid").setDescription("EMS-YYYY-###").setRequired(true))
    .addStringOption(o => o.setName("dato").setDescription("YYYY-MM-DD").setRequired(true))
    .addStringOption(o => o.setName("tid").setDescription("fx 18:00").setRequired(true))
    .addStringOption(o => o.setName("svar").setDescription("Kan/Måske/Kan ikke").setRequired(true)
      .addChoices({ name:"Kan",value:"Kan" },{ name:"Måske",value:"Måske" },{ name:"Kan ikke",value:"Kan ikke" }))
    .addStringOption(o => o.setName("note").setDescription("Valgfri note").setRequired(false)),

  new SlashCommandBuilder()
    .setName("arkiver")
    .setDescription("Arkiver elev (HR-only)")
    .addStringOption(o => o.setName("hrid").setDescription("EMS-YYYY-###").setRequired(true)),
].map(c => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
  console.log("✅ Slash commands registered");
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once("ready", async () => {
  console.log(`🚀 Bot online: ${client.user.tag}`);
  await registerCommands();

  // Reminders loop (hver 15 min)
  setInterval(async () => {
    try {
      const r = await callSheets({ secret: SHEETS_SECRET, action: "get_reminders" });
      if (!r.ok || !r.reminders?.length) return;

      const lines = r.reminders.map(x =>
        `• **${x.hrId}** — ${x.reason} (mentor: ${x.mentor || "—"}) ${x.threadUrl ? `| ${x.threadUrl}` : ""}`
      );
      await logToDiscord(client, `⏰ **Reminders**\n${lines.join("\n")}`);
    } catch (_) {}
  }, 15 * 60 * 1000);
});

client.on("interactionCreate", async (interaction) => {
  try {
    // BUTTONS
    if (interaction.isButton()) {
      const id = interaction.customId;

      // refresh
      if (id.startsWith("krav_refresh:")) {
        const hrId = id.split(":")[1];
        const r = await callSheets({ secret: SHEETS_SECRET, action: "get_requirements", hrId });
        if (!r.ok) return interaction.reply({ content: `❌ ${r.error}`, ephemeral: true });

        const emb = kravEmbed(hrId, r.edu, r.labels, r.checks, r.done, r.total);
        return interaction.update({ embeds: [emb], components: kravButtons(hrId, r.checks) });
      }

      // archive
      if (id.startsWith("krav_archive:")) {
        if (!isHR(interaction)) return interaction.reply({ content: "❌ Kun HR/Vejleder.", ephemeral: true });
        const hrId = id.split(":")[1];
        const r = await callSheets({ secret: SHEETS_SECRET, action: "archive_student", hrId, actorDiscord: `${interaction.user.tag} (${interaction.user.id})` });
        if (!r.ok) return interaction.reply({ content: `❌ ${r.error}`, ephemeral: true });
        await logToDiscord(client, `📦 Arkiveret via knap: **${hrId}** af ${interaction.user.tag}`);
        return interaction.reply({ content: `✅ Arkiveret: ${hrId}`, ephemeral: true });
      }

      // toggle krav
      if (id.startsWith("krav:")) {
        if (!isHR(interaction)) return interaction.reply({ content: "❌ Kun HR/Vejleder.", ephemeral: true });
        const [, hrId, idxStr] = id.split(":");
        const index = Number(idxStr);

        const t = await callSheets({
          secret: SHEETS_SECRET, action: "toggle_requirement",
          hrId, index, actorDiscord: `${interaction.user.tag} (${interaction.user.id})`
        });
        if (!t.ok) return interaction.reply({ content: `❌ ${t.error}`, ephemeral: true });

        const r = await callSheets({ secret: SHEETS_SECRET, action: "get_requirements", hrId });
        if (!r.ok) return interaction.reply({ content: `❌ ${r.error}`, ephemeral: true });

        const emb = kravEmbed(hrId, r.edu, r.labels, r.checks, r.done, r.total);
        await logToDiscord(client, `✅ Krav ${index} toggled for **${hrId}** af ${interaction.user.tag}`);
        return interaction.update({ embeds: [emb], components: kravButtons(hrId, r.checks) });
      }

      return;
    }

    // SLASH COMMANDS
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === "ping") {
      await interaction.deferReply({ ephemeral: true });
      const r = await callSheets({ secret: SHEETS_SECRET, action: "ping" });
      if (!r.ok) return interaction.editReply(`❌ ${r.error}`);
      return interaction.editReply(`✅ Sheets OK\nTS: ${r.ts}`);
    }

    if (interaction.commandName === "opret_elev") {
      if (!isHR(interaction)) return interaction.reply({ content: "❌ Kun HR/Vejleder.", ephemeral: true });
      await interaction.deferReply({ ephemeral: true });

      const discordName = interaction.options.getString("discordnavn", true);
      const discordId = interaction.options.getString("discordid", true);
      const charName = interaction.options.getString("karakter", true);
      const education = interaction.options.getString("uddannelse", true);
      const mentor = interaction.options.getString("vejleder", true);
      const threadLink = interaction.options.getString("threadlink") || "";

      const r = await callSheets({
        secret: SHEETS_SECRET,
        action: "create_student",
        discordName, discordId, charName, education, mentor,
        threadUrl: threadLink,
        actorDiscord: `${interaction.user.tag} (${interaction.user.id})`
      });

      if (!r.ok) return interaction.editReply(`❌ ${r.error}`);

      // auto template text
      const template = `Elev: ${discordName} (${r.hrId})\nUddannelse: ${education}\nVejleder: ${mentor}\n\n` +
        r.requirements.map((x, i) => `${i+1}. ${x} ☐`).join("\n");

      // auto-post i tråd/kanal hvis link givet og bot har adgang
      if (threadLink) {
        const parsed = parseDiscordLink(threadLink);
        if (parsed?.channelId) {
          try {
            const ch = await client.channels.fetch(parsed.channelId);
            if (ch) await ch.send({ content: "📋 **Uddannelses-checkliste**\n```" + template + "```" });
          } catch (_) {}
        }
      }

      await logToDiscord(client, `🆕 Oprettet **${r.hrId}** (${discordName}) af ${interaction.user.tag}`);
      return interaction.editReply(`✅ Oprettet: **${r.hrId}**\n\nSkabelon:\n\`\`\`\n${template}\n\`\`\``);
    }

    if (interaction.commandName === "find_elev") {
      await interaction.deferReply({ ephemeral: true });
      const query = interaction.options.getString("query", true);
      const r = await callSheets({ secret: SHEETS_SECRET, action: "find_students", query });

      if (!r.ok) return interaction.editReply(`❌ ${r.error}`);
      if (!r.results.length) return interaction.editReply("Ingen matches.");

      const lines = r.results.map(x =>
        `• **${x.hrId}** — ${x.discordName} | ${x.education} | ${x.status}${x.threadUrl ? ` | ${x.threadUrl}` : ""}`
      );

      return interaction.editReply(lines.join("\n").slice(0, 1900));
    }

    if (interaction.commandName === "elev") {
      await interaction.deferReply({ ephemeral: true });
      const hrId = interaction.options.getString("hrid", true);

      const s = await callSheets({ secret: SHEETS_SECRET, action: "get_student", hrId });
      if (!s.ok) return interaction.editReply(`❌ ${s.error}`);

      const st = s.student;

      const emb = new EmbedBuilder()
        .setTitle(`Elevkort — ${st.hrId}`)
        .addFields(
          { name: "Discord", value: `${st.discordName} (${st.discordId})`, inline: false },
          { name: "Karakter", value: st.charName || "—", inline: true },
          { name: "Uddannelse", value: st.education || "—", inline: true },
          { name: "Vejleder", value: st.mentor || "—", inline: true },
          { name: "Status", value: st.status || "—", inline: true },
          { name: "Tråd", value: st.threadUrl || "—", inline: false },
        );

      return interaction.editReply({ embeds: [emb] });
    }

    if (interaction.commandName === "set_status") {
      if (!isHR(interaction)) return interaction.reply({ content: "❌ Kun HR/Vejleder.", ephemeral: true });
      await interaction.deferReply({ ephemeral: true });

      const hrId = interaction.options.getString("hrid", true);
      const status = interaction.options.getString("status", true);

      const r = await callSheets({
        secret: SHEETS_SECRET, action: "set_status",
        hrId, status,
        actorDiscord: `${interaction.user.tag} (${interaction.user.id})`
      });

      if (!r.ok) return interaction.editReply(`❌ ${r.error}`);
      await logToDiscord(client, `🟦 Status ændret: **${hrId}** => **${status}** af ${interaction.user.tag}`);
      return interaction.editReply(`✅ Status sat: ${hrId} → ${status}`);
    }

    if (interaction.commandName === "krav") {
      await interaction.deferReply({ ephemeral: true });
      const hrId = interaction.options.getString("hrid", true);

      const r = await callSheets({ secret: SHEETS_SECRET, action: "get_requirements", hrId });
      if (!r.ok) return interaction.editReply(`❌ ${r.error}`);

      const emb = kravEmbed(hrId, r.edu, r.labels, r.checks, r.done, r.total);
      return interaction.editReply({ embeds: [emb], components: kravButtons(hrId, r.checks) });
    }

    if (interaction.commandName === "toggle_krav") {
      if (!isHR(interaction)) return interaction.reply({ content: "❌ Kun HR/Vejleder.", ephemeral: true });
      await interaction.deferReply({ ephemeral: true });

      const hrId = interaction.options.getString("hrid", true);
      const nr = interaction.options.getInteger("nr", true);

      const t = await callSheets({
        secret: SHEETS_SECRET, action: "toggle_requirement",
        hrId, index: nr,
        actorDiscord: `${interaction.user.tag} (${interaction.user.id})`
      });

      if (!t.ok) return interaction.editReply(`❌ ${t.error}`);

      const r = await callSheets({ secret: SHEETS_SECRET, action: "get_requirements", hrId });
      if (!r.ok) return interaction.editReply(`❌ ${r.error}`);

      const emb = kravEmbed(hrId, r.edu, r.labels, r.checks, r.done, r.total);
      await logToDiscord(client, `✅ Krav ${nr} toggled for **${hrId}** af ${interaction.user.tag}`);
      return interaction.editReply({ embeds: [emb], components: kravButtons(hrId, r.checks) });
    }

    if (interaction.commandName === "intro_checkin") {
      await interaction.deferReply({ ephemeral: true });

      const hrId = interaction.options.getString("hrid", true);
      const date = interaction.options.getString("dato", true);
      const time = interaction.options.getString("tid", true);
      const answer = interaction.options.getString("svar", true);
      const note = interaction.options.getString("note") || "";

      const r = await callSheets({
        secret: SHEETS_SECRET, action: "intro_checkin",
        discordName: interaction.user.username,
        discordId: interaction.user.id,
        hrId, date, time, answer, note,
        actorDiscord: `${interaction.user.tag} (${interaction.user.id})`
      });

      if (!r.ok) return interaction.editReply(`❌ ${r.error}`);
      await logToDiscord(client, `🗓️ Intro check-in: **${hrId}** => ${answer} af ${interaction.user.tag}`);
      return interaction.editReply("✅ Check-in gemt.");
    }

    if (interaction.commandName === "arkiver") {
      if (!isHR(interaction)) return interaction.reply({ content: "❌ Kun HR/Vejleder.", ephemeral: true });
      await interaction.deferReply({ ephemeral: true });

      const hrId = interaction.options.getString("hrid", true);
      const r = await callSheets({
        secret: SHEETS_SECRET, action: "archive_student",
        hrId,
        actorDiscord: `${interaction.user.tag} (${interaction.user.id})`
      });

      if (!r.ok) return interaction.editReply(`❌ ${r.error}`);
      await logToDiscord(client, `📦 Arkiveret: **${hrId}** af ${interaction.user.tag}`);
      return interaction.editReply(`✅ Arkiveret: ${hrId}`);
    }

  } catch (err) {
    console.error(err);
    const msg = `❌ Fejl: ${err?.message || String(err)}`;
    if (interaction.deferred || interaction.replied) {
      try { await interaction.editReply(msg); } catch(_) {}
    } else {
      try { await interaction.reply({ content: msg, ephemeral: true }); } catch(_) {}
    }
  }
});

client.login(DISCORD_TOKEN);
