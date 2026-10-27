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

A task started from chat works with the authority of whoever connected the bot, and anyone who finds a bot can message it. So a bot takes requests only from people you allow, and nobody at first.

Message the bot yourself. It answers that you are not allowed yet, and you appear under the bot's **Who can ask** in Settings → Events. Choose **Allow**. Anyone else who asks shows up there too, with what they asked. **Anyone** lets in everyone who can message the bot, e.g. a private Slack workspace.

## Ask

- **Telegram**: message the bot directly, or mention `@yourbot` in a group (or reply to one of its messages).
- **Slack**: mention `@yourbot` in a channel, or message it directly.
- **Discord**: `/tavya request: what you want done`.
- **WhatsApp**: message the number.

The bot answers **On it** with a link to the task. It writes again when the task needs your input, is ready for review, is done, fails or is cancelled. Reply in the same thread to answer its questions or add to the request; a new message starts a new task. Reviewing and approving the work happens in tavya.
