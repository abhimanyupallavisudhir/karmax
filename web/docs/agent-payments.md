# Give an agent a card with a budget

How an AI agent pays for something on tavya: save your own virtual card, give a task a budget, and approve any payment above it. The agent fills the card in at checkout without seeing its number.

## The card is yours

tavya does not issue or fund cards. You save one you already hold: a virtual card with a spending limit, made in your own banking app. Your bank enforces the limit.

## Add a card

In the organization's **Settings → Passwords & payments**, under **Saved cards**, open **Add card**:

1. Fill in **Card name**, **Limit (USD)**, **Card number**, **Expiry**, **CVC** and the **Billing address**.
2. Under **Merchant restrictions**, **Allowed domains** limits the card to the sites you list.
3. Press **Add card**.

The number and CVC are stored encrypted in the vault, and the console shows only the last four digits. tavya cannot see the card's balance: when you raise the limit with your bank, press **Raise limit** to match. **Revoke** deletes the card.

## Give a task a budget

In the task form, open the agent's **Authorization** row:

- **Cards**: the cards this task may use. Unless you choose, it may use every saved card.
- **Budget**: the most the task may spend in total. Blank means no limit, so nothing asks for approval. With 0, every payment asks you first.

New tasks start from **Task defaults** in the organization's or project's settings. The organization's budget starts at $0, so every payment waits for approval until you change it. A running task's **Parameters** tab has the same fields, and what it has spent.

## What happens at checkout

1. The agent asks to spend an amount on a card at a site, and says why.
2. Within the budget, the amount is reserved and the agent goes on.
3. Above the budget, the task waits. Press **Approve spend** or **Deny spend** on the task, or **Approve** or **Deny** under **Spend requests** in **Settings → Passwords & payments**. Raising the task's budget far enough also approves it.
4. tavya fills the card into the checkout form in the agent's browser. The number and CVC never enter the conversation. The fill works only on the site the agent named.

A payment larger than what is left of the card's limit waits too. A site outside the card's **Allowed domains** is refused.

## The record

**Settings → Passwords & payments** lists open **Spend requests** and, under **Payment activity**, each payment's amount, site, status and time. tavya also records each fill with its task and site. This is what agents reserved; your bank's statement says what was charged.

## Logins for the site

To pay, an agent often has to sign in. Add the login under **Passwords** in the same settings, then pick it with **Vault credentials** in the task form. Each login has two settings:

- **Blind use** (**Automatic** or **Ask**): the agent types the password into the sign-in form without seeing it.
- **Agent sees** (**Ask**, **Automatic** or **Never**): the password is handed to the agent, so it travels to the model provider.

## Cautions

- An agent can leak any password it may see or use, even with **Blind use**, for example by entering it on a malicious site.
- After a fill, the checkout page holds the card, in a browser the agent controls.
- Set the card's limit to an amount you can afford to lose.

## Next

- [How it works](/docs/how-it-works)
- [Let one agent review another](/docs/agent-review)
- [Schedule tasks and react to events](/docs/scheduled-tasks)
