# Chat bots

Ask a project for work from Telegram, Slack, Discord or WhatsApp. Each request becomes a task, and the bot answers in the same thread.

## Connect a bot

1. Create the bot on its platform:
   - **Telegram**: message [@BotFather](https://t.me/BotFather), send `/newbot` and copy the token. To use it in groups, also send `/setprivacy` and choose **Disable**, so it sees messages that mention it.
   - **Slack**: [create an app](https://api.slack.com/apps) with the bot scopes `app_mentions:read`, `chat:write` and `im:history`, allow messages under **App Home → Messages Tab**, install it, and copy its **Signing secret** and **Bot token** (`xoxb-…`).
   - **Discord**: [create an application](https://discord.com/developers/applications) and copy its **Application ID**, **Public key** and **Bot token**. Invite the bot to your server with the `bot` and `applications.commands` scopes.
   - **WhatsApp**: in a Meta app with a WhatsApp Business number, copy the **Phone number ID**, **App secret** and an **Access token**.
2. In tavya, open the project's **Settings → Events**, choose **＋ Chat bot**, paste them and **Connect**. Keep **Start a task for each message** on.
3. Slack and WhatsApp only: paste the URL tavya shows into your app. For Slack it goes under **Event Subscriptions → Request URL**, with the bot events `app_mention` and `message.im`. For WhatsApp, paste the **Callback URL** and **Verify token** under **WhatsApp → Configuration**. Telegram and Discord are set up for you.

## Who can ask

Anyone who finds a bot can message it, so it only takes requests from people it knows.

**Link your account.** Message the bot. It answers with a link; open it, signed in to tavya, and choose **Link**. From then on, a task your messages start is yours: it is created by you, does no more than you may do in the project, and its questions and approvals come to you. A link works for 15 minutes and once; message the bot again for a new one. Each bot has its own links, and you can remove yours under **Profile → Chat accounts**. Someone linked who cannot start tasks in the project is told so, and nothing starts.

**Guests.** People without a tavya account can still ask, as guests of whoever connected the bot: their tasks work with that person's authority. Choose **Allow** beside someone under the bot in **Settings → Events**: everyone who messaged the bot without being let in shows up there, with what they asked. **Anyone** makes everyone who can message the bot a guest, e.g. in a private Slack workspace. The bot's **Linked** row lists the people linked to it, and the project can remove them.

## Ask

- **Telegram**: message the bot directly, or mention `@yourbot` in a group (or reply to one of its messages).
- **Slack**: mention `@yourbot` in a channel, or message it directly.
- **Discord**: `/tavya request: what you want done`.
- **WhatsApp**: message the number.

The bot answers **On it** with a link to the task. It writes again when the task needs your input, is ready for review, is done, fails or is cancelled. Reply in the same thread to answer its questions or add to the request; a new message starts a new task. Reviewing and approving the work happens in tavya.
