# Let one agent review another

Have Codex review Claude Code's pull request, or the other way round, with tavya: each review step is a person or an agent, on the model you choose.

## The Review route

When a task's agent finishes, the task moves to **Review**. Its **Review route** is the list of steps the review passes through, in order. Each step is **Human** (a person, a team or a group confirms) or **Agent** (a Reviewer agent decides). Every step must approve before the task lands.

By default the route is one human step: the task's creator. A route with no steps says **Auto-confirms**.

## Add a reviewer on another model

1. Press **New task** (or **N**) and write the task. Under **Agent**, choose the model that does the work, say a Claude model.
2. Under **Review route**, switch the step to **Agent**. To keep your own step as well, press **+ Add step** and order the steps with **↑** and **↓**.
3. In the step's model field, pick a model from another vendor, for example a Codex one. Typing `codex` filters the list.
4. Optionally write instructions for the Reviewer, such as "Check that the tests cover the change."
5. Optionally set **Revise limit**: how many times in a row this Reviewer may send the work back before the Review goes to people. Empty means no limit.
6. Press **Run task**.

To use the same route for every task, set it in **Settings → Task defaults**, for the organization or one project. On a running task, change it on the **Parameters** tab until its Review has passed.

## What the Reviewer sees and does

- It works on the task's own computer, with the same tools as the agent that did the work. It can read the changes, run the tests and open the app.
- It reads the whole conversation, with each speaker named, and speaks in it as **Reviewer**.
- It confirms, and the review moves to the next step or the task lands. Or it sends the work back with what to change: the first agent works again, and the next Review starts from the first step.

## Call in another agent mid-task

In a task's message box, type **@**. The menu lists the task's agents, **New agent…** and people. Choose **New agent…**, pick its model, and say what you want, for example "check the migration for data loss".

The new agent joins the same conversation, works on the same computer, and answers you. One agent works at a time: an agent called while another is busy starts when that turn ends.

## Let an agent answer questions

The **Responder** gets the main agent's questions. It is **Human** by default, so a question shows as **Needs input** and waits for you. Switch it to **Agent**, pick a model, and that agent answers so the work goes on. It can still pass a question on to people.

## When to keep a person in the loop

- **For work you want to read yourself.** Put a **Human** step after the **Agent** step. The agent reviews first, and you confirm last.
- **When two agents might go round in circles.** Set a **Revise limit**, so the Review comes to people after that many rounds.
- **When the task turns on your decisions.** Keep the **Responder** human.

A task's agents never get more authorization than the person who started it, whoever reviews.

## Next

- [Run many agents in parallel](/docs/parallel-agents): many tasks, each reviewed on its own.
- [Schedule tasks and react to events](/docs/scheduled-tasks): repeatable work that an agent reviews.
- [How it works](/docs/how-it-works): agents, the Responder and authorization.
