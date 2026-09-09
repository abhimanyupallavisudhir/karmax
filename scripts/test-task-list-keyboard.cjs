// Real Chromium regression for task-list keyboard activation. Boots the shipped
// console against fixture API responses; navigation and rendering are unmodified.
// Install playwright and its Chromium, then run: node scripts/test-task-list-keyboard.cjs
// PLAYWRIGHT_MODULE / CHROMIUM_EXECUTABLE can use an existing browser installation.
// APP_SOURCE optionally verifies a previous app.js against the same regression.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const root = path.resolve(__dirname, "../web");
const tasks = [1, 2].map((n) => ({
  id: `task_${n}`,
  num: n,
  title: `Keyboard task ${n}`,
  projectId: "p1",
  workflow: "software-dev",
  params: {},
  createdAt: n,
  lastView: {
    taskId: `task_${n}`,
    title: `Keyboard task ${n}`,
    status: "completed",
    stage: "done",
    state: {},
    agents: [],
  },
}));
(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_EXECUTABLE,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/*", async (route) => {
    const u = new URL(route.request().url());
    const p = u.pathname;
    if (p.startsWith("/api/")) {
      let data = [];
      if (p === "/api/meta") data = {};
      else if (p === "/api/launch") data = {};
      else if (p === "/api/session")
        data = { authenticated: true, user: { id: "u1", name: "Tester" } };
      else if (p === "/api/organizations")
        data = [{ id: "o1", slug: "test", name: "Test" }];
      else if (p === "/api/user/default-organization")
        data = { organizationId: "o1" };
      else if (p === "/api/projects")
        data = [
          {
            id: "p1",
            slug: "project",
            name: "Project",
            organizationId: "o1",
            config: {},
          },
        ];
      else if (p === "/api/contributions")
        data = {
          commands: [],
          workflows: [],
          slots: [
            {
              contribution: {
                slot: "queue-panel",
                component: "merge-queue",
                title: "Merge queue",
              },
            },
          ],
        };
      else if (p === "/api/schema") data = [];
      else if (p === "/api/models") data = { providers: [] };
      else if (p === "/api/projects/p1/tasks") data = tasks;
      else if (p === "/api/projects/p1/search") data = { tasks, total: 2 };
      else if (p === "/api/projects/p1/avatars")
        data = { avatars: [], availability: {} };
      else if (/^\/api\/tasks\/task_\d$/.test(p))
        data = tasks.find((t) => p.endsWith(t.id)).lastView;
      else if (p.endsWith("/attempts")) data = null;
      else if (p.endsWith("/sessions")) data = {};
      else if (p.endsWith("/events")) data = { events: [] };
      return route.fulfill({ json: data });
    }
    if (p === "/service-worker.js") return route.abort();
    let file = path.join(root, p);
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory())
      file = path.join(root, "index.html");
    let body = fs.readFileSync(file);
    if (p === "/app.js")
      body =
        fs.readFileSync(process.env.APP_SOURCE || file, "utf8") +
        "\nwindow.keyboardTest = { S, renderMain };";
    await route.fulfill({
      body,
      contentType: file.endsWith(".js")
        ? "text/javascript"
        : file.endsWith(".css")
          ? "text/css"
          : file.endsWith(".html")
            ? "text/html"
            : "image/svg+xml",
    });
  });
  const listUrl = "http://keyboard.test/test/project/tasks";
  async function reset() {
    await page.goto(listUrl);
    await page.waitForSelector(".task-row");
  }
  async function opened(n) {
    await page.waitForSelector("#tp-back", { timeout: 3000 });
    await page.waitForSelector(".tp-body");
    assert.equal(new URL(page.url()).pathname, `/test/project/tasks/${n}`);
    assert.match(
      await page.locator("#main").innerText(),
      new RegExp(`Keyboard task ${n}`),
    );
  }
  try {
    for (const keys of [
      ["ArrowDown"],
      ["j"],
      ["ArrowDown", "ArrowDown", "ArrowUp"],
      ["j", "j", "k"],
    ]) {
      await reset();
      for (const key of keys) await page.keyboard.press(key);
      assert.equal(
        await page.locator(".task-row.cursor").getAttribute("data-id"),
        "task_1",
      );
      await page.keyboard.press("Enter");
      await opened(1);
      console.log(`PASS ${keys.join(" → ")} → Enter opens task page`);
    }
    await reset();
    for (let i = 0; i < 50; i++) {
      await page.keyboard.press("Tab");
      if (
        await page.evaluate(() => document.activeElement.matches(".task-row"))
      )
        break;
    }
    assert.equal(
      await page.evaluate(() => document.activeElement.dataset.id),
      "task_1",
    );
    await page.keyboard.press("Enter");
    await opened(1);
    console.log("PASS Tab → Enter opens task page");

    await reset();
    await page.keyboard.press("j");
    await page.keyboard.press("j");
    await page.evaluate(() => window.keyboardTest.renderMain());
    assert.equal(
      await page.evaluate(() => document.activeElement.tagName),
      "BODY",
    );
    await page.keyboard.press("Enter");
    await opened(2);
    console.log("PASS Enter preserves selection after a background redraw");

    await reset();
    await page.locator(".row-link").first().click();
    await opened(1);
    console.log("PASS mouse activation still opens task page");

    await reset();
    await page.keyboard.press("j");
    await page.locator("[data-archive]").first().focus();
    const archived = page.waitForRequest(
      (r) => r.method() === "POST" && r.url().includes("/archive"),
    );
    await page.keyboard.press("Enter");
    await archived;
    assert.equal(page.url(), listUrl);
    console.log("PASS nested native button keeps its action");

    await reset();
    await page.evaluate(() => {
      const button = document.createElement("span");
      button.role = "button";
      button.tabIndex = 0;
      button.id = "custom-action";
      button.textContent = "Custom action";
      button.onclick = () => (button.dataset.clicked = "yes");
      document.querySelector(".task-row").append(button);
      button.focus();
    });
    await page.keyboard.press("Enter");
    assert.equal(
      await page.locator("#custom-action").getAttribute("data-clicked"),
      "yes",
    );
    assert.equal(page.url(), listUrl);
    console.log("PASS nested custom control keeps its action");

    await reset();
    await page.keyboard.press("j");
    await page.locator("#task-search").focus();
    await page.keyboard.press("Enter");
    assert.equal(page.url(), listUrl);
    console.log("PASS Enter in input does not open the cursor task");

    await reset();
    await page.evaluate(() => {
      const { S, renderMain } = window.keyboardTest;
      S.tasks[0].lastView.stage = "merge";
      S.tab = "queue";
      renderMain();
    });
    await page.keyboard.press("ArrowDown");
    assert.equal(
      await page.evaluate(() => document.activeElement.matches(".queue-item")),
      true,
    );
    await page.keyboard.press("Enter");
    await opened(1);
    console.log("PASS queue row → Enter opens task page");

    await reset();
    await page.evaluate(() => {
      const { S, renderMain } = window.keyboardTest;
      S.tasks[0].params.draft = true;
      S.searchResult = null;
      renderMain();
    });
    await page.locator('[data-draft="task_1"]').focus();
    await page.keyboard.press("Enter");
    await page.waitForSelector("#tf-page");
    console.log("PASS draft row → Enter opens task form");
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
