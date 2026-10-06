import { boundedExec } from '../world/bounded-exec.js';
import { currentTiming, timed, withTiming } from '../timing/index.js';
import { PlatformToolContext } from './types.js';
import { parseTransition } from '../resolve/transitions.js';
import { MAX_REVIEW_TEXT_LENGTH, ReviewInfoRejected, validateReviewInfoCall } from './review-info.js';
import { World } from '../world/types.js';
import { readWorldFilePrefix } from '../world/file-prefix.js';
import { startJob, jobStatuses, describeJobs, listJobs, stopJobs, MAX_JOB_NAME } from '../world/jobs.js';
import { PLATFORM_API_CATALOG } from '../platform/catalog.js';
import {
  PLATFORM_REQUEST_BODY_SCHEMA, PRIORITY_NAMES, AGENT_ROLE_NAMES,
  compactSearch, compactOrganizationSearch, compactTags, normalizeRequestBody, platformRequestPathError,
} from '../platform/platform-request.js';
import { URGENCY_LEVELS, type AgentWait, type Urgency } from '../domain/types.js';
import { BRAND } from '../domain/brand.js';

/** The longest a single wait may last: a week, after which a parked world may hibernate. */
export const MAX_WAIT_MINUTES = 7 * 24 * 60;

/** Provider-neutral tool descriptor (mapped to OpenAI / MCP shapes per adapter). */
export interface ToolSchema {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

const MAX_OUTPUT = 12_000;
const truncate = (s: string) => (s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + '\n…(truncated)' : s);
/** UTF-8 spends at most 3 bytes per UTF-16 unit, so this many bytes always decode past MAX_OUTPUT. */
const READ_FILE_MAX_BYTES = MAX_OUTPUT * 4;

export { MAX_REVIEW_TEXT_LENGTH };

/** How loudly an ask asks. One shared parameter across every human-facing tool,
 * so an agent learns the vocabulary once. See `Urgency` in domain/types.ts. */
const URGENCY_PARAMETER = {
  type: 'string',
  enum: URGENCY_LEVELS,
  description: 'How loudly to ask: low | normal | high | critical. It orders the human\'s inbox and decides '
    + 'whether their device alerts them. Approval requests default to high; reserve critical for something that '
    + 'goes wrong if it waits.',
} as const;

/**
 * The tools every real agent gets: do real work in the world (bash/read/write)
 * plus the platform tools (SPEC §5.2). `open_pr` is the Do agent's explicit
 * proposal transition; signal_completion remains an optional structured summary.
 */
export const TOOL_SCHEMAS: ToolSchema[] = [
  {
    name: 'bash',
    description: 'Run a shell command in the task working directory. Returns stdout/stderr and exit code.',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string', description: 'The shell command to run.' } },
      required: ['command'],
    },
  },
  {
    name: 'read_file',
    description: 'Read a UTF-8 text file relative to the working directory.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a UTF-8 text file relative to the working directory.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
  },
  {
    name: 'create_review_info',
    description:
      "Optional. Attach click-to-verify affordances only when they are relevant: `run` actions for useful verification commands (including starting an app/server; set `server: true` and use `openUrls` to open it), and `open` actions for human-readable outputs such as reports, documents, images, or videos. Local open targets must exist and be at most 100 MiB each; their current bytes are saved in durable artifact storage so they remain available after the task lands. Source code is not a human-readable output and must not be attached as an `open` action. `caption` is optional, at most 280 characters, and says WHAT to verify. Put summaries of changes/answers in your normal response, or in a file only when the task requests one. The changed-files list is added automatically.",
    parameters: {
      type: 'object',
      properties: {
        caption: {
          type: 'string',
          maxLength: MAX_REVIEW_TEXT_LENGTH,
          description: 'Optional, at most 280 characters: WHAT to verify (not a summary of what you did).',
        },
        actions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['run', 'open'] },
              label: { type: 'string', description: 'Short button label.' },
              command: { type: 'string', description: 'run: the shell command executed in the world.' },
              server: { type: 'boolean', description: 'run: command is a long-lived server/watcher (stream logs + Stop).' },
              openUrls: { type: 'array', items: { type: 'string' }, description: 'run: URLs to open once it is up.' },
              target: { type: 'string', description: 'open: a human-readable output (not source code), as a world-relative path or absolute URL.' },
            },
            required: ['kind', 'label'],
          },
        },
      },
    },
  },
  {
    name: 'create_sub_task',
    description:
      'Delegate to a child task. It branches off your current work and merges back into YOUR branch (not main), and YOU are its confirmer: when it reaches Review or gets stuck it will raise to you (surfaced as a message) and you answer with respond_to_sub_task. It starts when your current turn ends. You manage your children to completion before you finish. '
      + 'It runs your agent unless `params` choose another: create_task\'s task-form fields, e.g. {"agent:do": {"provider": "codex", "model": "gpt-5.5", "effort": "high"}} or {"agent:do": {"avatarId": "…"}}. Only the agent fields can be set; the branch, project and authorization stay yours. An invalid or unavailable choice is refused and nothing is created.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        prompt: { type: 'string' },
        params: { type: 'object', description: 'Task-form agent fields for the child (e.g. "agent:do"), as in create_task; omit to run your agent.' },
      },
      required: ['title', 'prompt'],
    },
  },
  {
    name: 'respond_to_sub_task',
    description:
      'Answer a sub-task that raised to you. action: "open_pr" (its completed work should open a PR and enter Review), "confirm" (approve what it has: lands a PR at Review, or opens the PR of a child whose turn ended without one), "comment" (send guidance/answer its question so it keeps working), "retry" (retry a failed step), or "cancel" (abandon it). Omit child_task_id to answer all waiting children. The answer is delivered when your current turn ends.',
    parameters: {
      type: 'object',
      properties: {
        child_task_id: { type: 'string', description: 'The raising child; omit to respond to all waiting children.' },
        action: { type: 'string', enum: ['open_pr', 'confirm', 'comment', 'retry', 'cancel'] },
        text: { type: 'string', description: 'For "comment": the message/answer/guidance to send down.' },
      },
      required: ['action'],
    },
  },
  {
    name: 'raise_to_parent',
    description:
      'Sub-tasks ONLY: ask your parent task for a decision and pause until it replies. type: "needs_info" (a question about your assignment), "needs_permission" (you need approval to do something), "needs_confirmation" (approve what you have), or "blocked" (you are stuck). The parent (or a human) answers; a "comment" reply resumes you with that guidance. Calling this pauses your turn.',
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['needs_info', 'needs_permission', 'needs_confirmation', 'blocked'] },
        detail: { type: 'string', description: 'What you need from the parent (shown to it).' },
      },
      required: ['type'],
    },
  },
  {
    name: 'wait_for_subtasks',
    description:
      'Pause until your running sub-tasks finish (or one raises to you). Your sub-tasks run in the background — you can keep working instead of calling this; call it only when you have nothing to do but wait for them. You are resumed the moment a sub-task finishes or needs you.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'start_job',
    description:
      'Run a long command (a render, build, training run, large test suite) as a durable job. Unlike your own shell — foreground, run_in_background, even nohup/setsid — a job keeps running after your turn ends or is interrupted. Output goes to the returned log file. Then call pause with the job id to be resumed when it finishes.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command, run with bash.' },
        cwd: { type: 'string', description: 'Directory to run in; relative paths are from your working directory (the default).' },
        name: { type: 'string', maxLength: MAX_JOB_NAME, description: 'A short name people see while you wait on it, e.g. "render" or "test suite".' },
      },
      required: ['command'],
    },
  },
  {
    name: 'pause',
    description:
      'End your turn to wait for durable jobs or a real-world event (CI, a deploy, a set time), and be resumed when every listed job has finished, when a message arrives, or after `minutes`, whichever comes first. Without jobs it is a timed pause; list every job that is still running, or the paused world could freeze it. You are resumed with each job\'s exit code and last output. ' +
      'It is not for asking: if you need an answer to continue, call escalate_to_human or end your turn with the question. Set needs_input only when you are waiting anyway and someone may answer meanwhile, and you will carry on without the answer once `minutes` pass: the task then shows Needs input and notifies them. After calling it, end your turn.',
    parameters: {
      type: 'object',
      properties: {
        minutes: { type: 'number', description: `Resume after this many minutes at the latest (1–${MAX_WAIT_MINUTES}). With jobs, set it comfortably above their expected run time.` },
        jobs: { type: 'array', items: { type: 'string' }, description: 'Job ids from start_job to wait for.' },
        needs_input: { type: 'boolean', description: 'While you wait, someone may answer, and you carry on without it at the deadline: ask them and show Needs input instead of Waiting. For an answer you need, use escalate_to_human instead.' },
        message: { type: 'string', minLength: 1, maxLength: 4_000, description: 'With needs_input: the question (default: your final response).' },
        audience: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          maxItems: 32,
          description: 'With needs_input: who to ask — user:<id>, @team:<slug>, @creator, @owners, @project, or @all (see escalate_to_human). Default: whoever answers this task\'s questions (for a sub-task, its parent).',
        },
        urgency: URGENCY_PARAMETER,
      },
      required: ['minutes'],
    },
  },
  {
    name: 'stop_job',
    description: 'Stop durable jobs you no longer need (the job and every process it started). Use this rather than kill or pkill.',
    parameters: {
      type: 'object',
      properties: { jobs: { type: 'array', items: { type: 'string' }, description: 'Job ids from start_job.' } },
      required: ['jobs'],
    },
  },
  {
    name: 'create_branch',
    description:
      'Multi-PR tasks ONLY: split this task\'s change across another branch, so it is reviewed and merged as its own pull request. The branch is checked out beside your current one immediately — work in it during this same turn (`cd` to the path returned). Use it when one review would mix unrelated concerns: a prep/refactor under a feature, or slices of different repos. Stack with `base`: pass a SIBLING checkout\'s name and this branch builds on it and lands after it. All branches stay one task with one Review and one Merge — if a piece needs its own review timing or cancellation, use create_sub_task instead. Fails on a single-branch task; do not retry, just keep working in the one branch.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Short name for this branch: its directory, and the label on its pull request (e.g. "refactor", "docs").',
        },
        from: { type: 'string', description: 'Name of the existing checkout whose REPOSITORY to branch (default: the one you started in). Use for a second repo.' },
        base: { type: 'string', description: 'A sibling checkout\'s name to stack on top of, or a git ref. Default: the same base your current branch has.' },
        target: { type: 'string', description: 'Branch this one should merge into. Default: the same target as the checkout it came from.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'save_skill',
    description: 'Save a reusable skill (markdown) for future tasks; saving the same name overwrites it. It is saved to your task\'s project, or for your whole organization if your task has organization-wide authority (organization:wiki:write); the result says which. For content that task prompts should include, write a wiki page instead (platform_request PUT /api/{organizations|projects}/:id/wiki/page).',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string' }, content: { type: 'string' } },
      required: ['name', 'content'],
    },
  },
  {
    name: 'read_wiki',
    description:
      'Navigate an organization or project wiki (skills, memories, prompts). No path → the full table of contents (this also expands any [more…] fold); a section path → that section listed in full; a skill/memory path → its complete markdown plus attached files. Your prompt names the scope ids that apply to your task.',
    parameters: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['organization', 'project'] },
        id: { type: 'string', description: 'The organization or project id.' },
        path: { type: 'string', description: 'Wiki-relative folder path of a section or skill; omit for the full TOC.' },
      },
      required: ['scope', 'id'],
    },
  },
  {
    name: 'search_wiki',
    description: 'Grep every page of an organization or project wiki with a case-insensitive regular expression; returns file:line matches.',
    parameters: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['organization', 'project'] },
        id: { type: 'string', description: 'The organization or project id.' },
        query: { type: 'string' },
      },
      required: ['scope', 'id', 'query'],
    },
  },
  {
    name: 'request_spend',
    description:
      'Reserve authorization to pay with a permitted project/organization card. Amount in the smallest unit of the card\'s currency (cents for USD, whole yen for JPY; the task\'s payment context gives each scale). Returns granted, needs_approval, needs_funding, or denied. If not granted, stop and report — the human will raise the card limit or approve, then you can retry.',
    parameters: {
      type: 'object',
      properties: {
        amount: { type: 'number', description: 'Amount in the smallest unit of the card\'s currency, e.g. 1250 for 12.50 USD or 1250 for 1,250 JPY.' },
        card_id: { type: 'string', description: 'Optional card id, as an alternative to card_name.' },
        card_name: { type: 'string', description: 'Name of the card to use (unique within the organization). Follow the user’s instructions about which card to use.' },
        merchant: { type: 'string' },
        why: { type: 'string', description: 'Why this purchase is needed (shown to the human).' },
      },
      required: ['amount', 'why'],
    },
  },
  {
    name: 'fill_payment_card',
    description:
      'After request_spend returns granted, securely fill that reserved card into checkout inputs in your own browser (the one your browser tools drive). Card number and CVC never enter your context. Use the returned request_id; merchant in request_spend must be the checkout domain.',
    parameters: {
      type: 'object',
      properties: {
        request_id: { type: 'string' },
        number_selector: { type: 'string', description: 'CSS selector, or @focused after you focus an iframe field with the browser tool.' },
        cvc_selector: { type: 'string', description: 'CSS selector; @tab advances once from the prior field before typing.' },
        expiry_selector: { type: 'string', description: 'Combined MM/YY field. Use this or both month/year selectors. @tab advances once from the prior field.' },
        exp_month_selector: { type: 'string' },
        exp_year_selector: { type: 'string' },
        line1_selector: { type: 'string', description: 'Optional billing street field; filled only when the card carries a billing address.' },
        city_selector: { type: 'string', description: 'Optional billing city field.' },
        postal_code_selector: { type: 'string', description: 'Optional billing postal/ZIP field.' },
        country_selector: { type: 'string', description: 'Optional billing country field.' },
      },
      required: ['request_id', 'number_selector', 'cvc_selector'],
    },
  },
  {
    name: 'list_connections', description: 'List app accounts explicitly shared with this task or project. Prefer these to requesting passwords; tokens stay server-side.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'request_connection', description: 'Request access to an app for this task. Prefer a native MCP server: pass mcp as its MCP Registry name (e.g. com.example/gmail, find one with GET /api/mcp/registry?search=) or its public HTTPS URL. Use toolkit (a Composio slug such as gmail or googlecalendar) only as the fallback when no suitable remote MCP server exists. The user allows an account they already connected or signs in; a Connect button appears in this task and it resumes automatically. Continue independent work, but do not finish while the connection is pending. Reuse accounts from list_connections.',
    parameters: { type: 'object', properties: { mcp: { type: 'string' }, toolkit: { type: 'string' }, why: { type: 'string' } }, required: ['why'] },
  },
  {
    name: 'search_connection_tools', description: 'Search tools and input schemas for a connected account. Use the exact returned tool slug and schema with execute_connection_tool.',
    parameters: { type: 'object', properties: { connection_id: { type: 'string' }, search: { type: 'string' } }, required: ['connection_id', 'search'] },
  },
  {
    name: 'execute_connection_tool', description: 'Execute one app tool on the exact connected account within the user’s task instructions. Search its schema first. Writes take effect immediately; connecting an account does not authorize unrelated actions. Before retrying a failed write, check whether it succeeded.',
    parameters: { type: 'object', properties: { connection_id: { type: 'string' }, tool: { type: 'string' }, arguments: { type: 'object', additionalProperties: true } }, required: ['connection_id', 'tool', 'arguments'] },
  },
  {
    name: 'list_credentials',
    description:
      'List the accounts and other vault credentials this task is authorized to use. Returns non-secret metadata including each item id, label, type, domains, username when present, stored field names, and effective use/reveal policy. Call this before guessing a domain or requesting new access.',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'request_credential',
    description:
      `Ask for access to a credential in the user's vault (a site login, API key, SSH key, or .env bag) that list_credentials does not show, identified by item_id or the site's domain. Returns granted (proceed with fill_credential/get_credential), needs_approval or not_in_vault (a request is parked for the human and this turn may stop — ${BRAND} automatically resumes the task with the decision), or denied (do not re-ask). If a stored credential turns out to be WRONG (the site rejects it) and you cannot self-reset (recovery goes to the human's own inbox, not the agent mailbox), report it with kind: "reset" — the human fixes the item or sends the reset code, then ${BRAND} resumes the task. Prefer an app connection (request_connection) when the service offers one, and ask for reveal only when use cannot work: a revealed secret is sent to your model provider.`,
    parameters: {
      type: 'object',
      properties: {
        item_id: { type: 'string', description: 'A vault item id. Use list_credentials to inspect credentials already granted to this task.' },
        domain: { type: 'string', description: 'The site this credential is for, e.g. "github.com" — used when you do not know the item id.' },
        mode: { type: 'string', enum: ['use', 'reveal'], description: 'use = fill/inject without seeing the secret (default); reveal = you need the plaintext.' },
        kind: { type: 'string', enum: ['access', 'reset'], description: 'reset = the stored secret appears invalid; always parks for the human.' },
        why: { type: 'string', description: 'Why you need it / what failed (shown to the human).' },
        urgency: URGENCY_PARAMETER,
      },
      required: ['why'],
    },
  },
  {
    name: 'fill_credential',
    description:
      `Type a vault credential into the page open in your browser WITHOUT the secret ever entering your context: ${BRAND} resolves it and types it over CDP, verifying the page origin matches the credential's domains first. Focus the login page, then call this per field (username, password, then totp if the site asks for a code). The ${BRAND} browser MCP already runs a Chrome that exposes the DevTools endpoint, so just drive the page normally — no manual Chrome launch needed. A needs_approval response already parks the approval request for the human (its requestId is returned) — do NOT also call request_credential; just wait for the decision, which resumes the task.`,
    parameters: {
      type: 'object',
      properties: {
        item_id: { type: 'string' },
        domain: { type: 'string', description: 'Alternative to item_id: the site domain.' },
        field: { type: 'string', enum: ['username', 'password', 'totp'], description: 'Default password. totp types the current one-time code.' },
        selector: { type: 'string', description: 'CSS selector of the input element to fill.' },
      },
      required: ['selector'],
    },
  },
  {
    name: 'get_credential',
    description:
      'Reveal a vault secret in plaintext (API key, password, SSH key, .env contents). Default login reveal includes notes; field note retrieves notes alone. This is the audited last resort — prefer fill_credential for browser logins and rely on spawn-time env injection for keys. Returns granted with the value, or needs_approval/denied per the item\'s reveal policy, or not_in_vault. A needs_approval response already parks the approval request for the human (its requestId is returned) — do NOT also call request_credential; just wait for the decision, which resumes the task.',
    parameters: {
      type: 'object',
      properties: {
        item_id: { type: 'string' },
        domain: { type: 'string' },
        field: { type: 'string', description: 'password | totp | secret | privateKey | env | note (defaults to the item type\'s main field).' },
      },
    },
  },
  {
    name: 'store_credential',
    description:
      'Save a credential into the user\'s vault so it outlives this task. Two uses: (1) a credential you just created (registered account, generated password, captured TOTP seed, minted API/SSH key); (2) ROTATION — after you change a password on a site, immediately update the granted item\'s `secrets` here (pass its `id`; metadata is ignored), or everyone is locked out with the stale value. Rotation is allowed for any item this task may use; full edits only for items this task created.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Omit to create; set to update an item this task created.' },
        type: { type: 'string', enum: ['login', 'api-key', 'ssh-key', 'env', 'note'] },
        label: { type: 'string' },
        domains: { type: 'array', items: { type: 'string' } },
        username: { type: 'string' },
        env_var: { type: 'string', description: 'api-key/ssh-key: env var to inject it under in future task worlds.' },
        secrets: {
          type: 'object',
          description: 'Field → secret value. login: password, totp (base32 seed or otpauth:// URI), note; api-key: secret; ssh-key: privateKey; env: env (KEY=VALUE lines); note: note.',
        },
      },
      required: ['type', 'label'],
    },
  },
  {
    name: 'verify_resource_revision',
    description: 'Verify an exact historical project resource revision by decrypting and hashing its bytes server-side. Requires project:settings:read in that project. Returns actual revision, storage location, validated tree digest/totals and per-file SHA256/size evidence without keys or internal refs. Default 100 files, maximum 1000 files / 256 MiB per page. Follow response nextOffset as offset on the same revision. Complete means whole-tree byte verification; partial covers only returned files; failed reports unreadable/corrupt storage or invalid offset. A byte-limit without offset progress cannot verify that oversized file. Does not mutate heads or leases.',
    parameters: {
      type: 'object', properties: {
        project_id: { type: 'string' }, resource_id: { type: 'string' }, revision_id: { type: 'string' },
        offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 1000 },
      }, required: ['project_id', 'resource_id', 'revision_id'],
    },
  },
  {
    name: 'propose_project_resource',
    description:
      'Stage newly-created non-Git task output as a durable candidate for Review. A path must contain no secrets; it is checked now and snapshotted into encrypted object storage when the task reaches Review (refreshed if it changes before Confirm), so keep it in place (Review shows whether it was saved); a vault_item_id references a credential this task just stored without revealing it. The resource becomes a project default on confirmation; reviewers can exclude it with PUT /api/tasks/:taskId/resources/:resourceId/selection {excluded:true} through platform_request. Provide exactly one source (path or vault_item_id) and one target (target_path, target_environment, or target_service). For direct administration, agents with project:settings:write can instead use platform_request on project resources, including storageLocationId and other authorized projects.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'World-relative non-secret file/directory in this task’s current generation.' },
        vault_item_id: { type: 'string', description: 'Agent-created vault item returned by store_credential.' },
        field: { type: 'string', description: 'Vault field; defaults to the item’s first stored field.' },
        name: { type: 'string', description: 'Human-facing project resource name.' },
        driver: { type: 'string', enum: ['volume@1', 'object-tree@1', 'secret@1', 'service@1', 'database@1'] },
        target_path: { type: 'string', description: 'World-relative path where adopted data/secret files materialize.' },
        target_environment: { type: 'string', description: 'Uppercase environment variable for an adopted secret/connection.' },
        target_service: { type: 'string', description: 'Uppercase connection variable for an adopted service/database.' },
        access: { type: 'string', enum: ['read', 'write'], description: 'Future task access; defaults to read.' },
        publish: { type: 'string', enum: ['discard', 'review'], description: 'Future changes to writable snapshot resources; defaults to review.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'check_agent_mail',
    description:
      'Read your organization\'s agent mailbox — the dedicated inbox for accounts YOU register (never the user\'s personal email). Use it to complete "check your email for a code / confirmation link" steps: returns the address to register with plus recent messages with any verification `code` and `link` already extracted. Mailboxes are per organization; you can only read your own. For a code sent to the user\'s own address instead, escalate with raise_to_parent.',
    parameters: {
      type: 'object',
      properties: {
        organization_id: { type: 'string', description: 'Your organization id (named in your prompt).' },
        match: { type: 'string', description: 'Filter to messages mentioning this (e.g. the site name or sender).' },
        since: { type: 'number', description: 'Only messages received after this epoch-ms timestamp.' },
      },
      required: ['organization_id'],
    },
  },
  {
    name: 'enroll_passkey',
    description:
      'Enroll a NEW passkey that belongs to tavya on the account open in your browser (you cannot use the user\'s own passkeys — the OS biometric is theirs). tavya prepares a virtual authenticator (origin-verified against `domain`); you then trigger the site\'s "create a passkey / add passkey" button; then call save_passkey with the returned authenticator_id. After this, use_passkey logs in with no 2FA prompt.',
    parameters: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'The site you are enrolling on, e.g. "example.com".' },
      },
      required: ['domain'],
    },
  },
  {
    name: 'save_passkey',
    description: 'After you triggered the site\'s passkey-create button (see enroll_passkey), store the newly created credential in the vault as a passkey item.',
    parameters: {
      type: 'object',
      properties: {
        authenticator_id: { type: 'string', description: 'The id returned by enroll_passkey.' },
        label: { type: 'string' },
        domains: { type: 'array', items: { type: 'string' } },
        username: { type: 'string' },
      },
      required: ['authenticator_id'],
    },
  },
  {
    name: 'use_passkey',
    description:
      `Log in with a ${BRAND}-enrolled passkey: ${BRAND} loads the stored credential into a virtual authenticator on the page; you then trigger the site's "sign in with a passkey" button. The secret never enters your context. Returns granted with an authenticator_id (call the passkey release route when done), or needs_approval/not_in_vault.`,
    parameters: {
      type: 'object',
      properties: {
        item_id: { type: 'string' },
        domain: { type: 'string', description: 'Alternative to item_id: the site domain.' },
      },
    },
  },
  {
    name: 'save_session',
    description:
      `Save the signed-in session of the site open in your browser (its cookies and storage) as a vault item, so later tasks start signed in with use_session. Works however the site was signed into, including "Sign in with Google/GitHub": sign in first (with fill_credential, a passkey, or ask a human to sign in through this task's desktop), then call this on the signed-in page. Values never enter your context. The vault copy is then refreshed from your browser after each turn. Pass item_id to replace a session with a new sign-in.`,
    parameters: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'The site, e.g. "notion.so". Cookies of other sites (such as the identity provider\'s) are never saved.' },
        item_id: { type: 'string', description: 'Refresh this saved session instead of creating one.' },
        label: { type: 'string' },
        username: { type: 'string', description: 'The account signed in, for people choosing between sessions.' },
        exclusive: { type: 'boolean', description: 'Only one task at a time may use it: for sites that sign other copies out when one is used.' },
      },
    },
  },
  {
    name: 'use_session',
    description:
      `Sign your browser into a site with a saved session (see save_session). Navigate to the site first; ${BRAND} restores its cookies and storage and reloads the page signed in, without the values entering your context. Returns granted; needs_approval (a request was raised; you are resumed when it is decided); busy (the session works in one task at a time and another task has it: pause, then retry); expired or not_in_vault. When it no longer works, the result names the site's saved password or passkey to sign in with; then call save_session with the item_id.`,
    parameters: {
      type: 'object',
      properties: {
        item_id: { type: 'string' },
        domain: { type: 'string', description: 'Alternative to item_id: the site domain.' },
        why: { type: 'string', description: 'Shown to the person asked to approve.' },
      },
    },
  },
  // ─── task list operations ────────────────────────────────────────────────
  // These mirror the platform MCP server one-for-one. They used to exist ONLY
  // there, so an agent in a remote/cloud world — which falls back to these
  // provider-neutral schemas instead of the gateway-backed stdio `karmax` MCP —
  // simply had no way to create, find, tag, prioritize, or signal a task. Cloud
  // worlds are the hosted default, so that was the largest practical gap in
  // "an agent with suitable authorization can do what a human can".
  {
    name: 'create_task',
    description:
      'Create a new task on a project task list. It is queued and started immediately unless `draft` is true. '
      + '`params` carries the full task-form field values for the chosen workflow (including `triggers`, so a draft can be armed on a schedule/dependency/event); '
      + '`tags` accepts names or `a/b` paths and creates missing ones. '
      + '`wiki_context` inlines wiki pages as `[[proj:…]]`/`[[org:…]]` references; omit to inherit the default-labelled pages, pass [] for none.',
    parameters: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
        title: { type: 'string' },
        prompt: { type: 'string' },
        workflow: { type: 'string' },
        wiki_context: { type: 'array', items: { type: 'string' } },
        draft: { type: 'boolean' },
        priority: { type: 'string', enum: [...PRIORITY_NAMES] },
        tags: { type: 'array', items: { type: 'string' } },
        params: { type: 'object', description: 'Full task-form field values for the workflow.' },
      },
      required: ['project_id', 'title', 'prompt'],
    },
  },
  {
    name: 'get_task',
    description: "Get a task's current view-model.",
    parameters: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] },
  },
  {
    name: 'list_tasks',
    description: 'List every task in a project as bare {id, title, workflow}. Prefer search_tasks — it takes a query and returns num/status/stage/priority/tags.',
    parameters: { type: 'object', properties: { project_id: { type: 'string' } }, required: ['project_id'] },
  },
  {
    name: 'search_tasks',
    description:
      'Search/organize a project\'s tasks with a Linear-style query and get back a compact list (num, title, status, priority, tags). '
      + 'Query grammar: `field:value` clauses AND together, commas = OR (`status:active,waiting`), `-` negates (`-tag:bug`), '
      + 'comparisons on numbers/dates (`priority:>=2`, `created:<7d`), quoted phrases, and bare words = full text. '
      + 'Fields: status, stage, priority, tag (a/b path matches descendants), workflow, created, updated, num, '
      + 'is:<facet> (open/draft/archived/pr/untagged/armed/scheduled/recurring/blocked-on-deps/series/run/…), '
      + 'trigger, schedule, nextRun, dependsOn:#N / blocks:#N, and any workflow param via `param.<key>`. '
      + '`for:me` / `for:<name|email>` = tasks waiting on that person plus their drafts; `project:<id|slug|name>`. '
      + 'Add `sort:priority-desc` and `group:tag`. An empty query returns everything. '
      + 'Pass organization_id instead of project_id to search every project of the organization you can read.',
    parameters: { type: 'object', properties: { project_id: { type: 'string' }, organization_id: { type: 'string' }, query: { type: 'string' } } },
  },
  {
    name: 'list_tags',
    description: 'List a project\'s tag catalogue as `a/b/c` paths, with kind and optional section description.',
    parameters: { type: 'object', properties: { project_id: { type: 'string' } }, required: ['project_id'] },
  },
  {
    name: 'tag_task',
    description:
      'Add and/or remove tags on a task, by name or `a/b` path. Tags are purely organizational — never sent to any agent. '
      + 'A name in `add` that does not exist is created (a slash path builds the hierarchy); a `remove` name that is not present is ignored.',
    parameters: {
      type: 'object',
      properties: { task_id: { type: 'string' }, add: { type: 'array', items: { type: 'string' } }, remove: { type: 'array', items: { type: 'string' } } },
      required: ['task_id'],
    },
  },
  {
    name: 'set_task_priority',
    description: 'Set a task\'s organizational priority — for search/sorting only, never sent to any agent.',
    parameters: {
      type: 'object',
      properties: { task_id: { type: 'string' }, priority: { type: 'string', enum: [...PRIORITY_NAMES] } },
      required: ['task_id', 'priority'],
    },
  },
  {
    name: 'signal_task',
    description: `Send a signal to a task (confirm, cancel, retry, or followUp with text). For a followUp, \`role\` optionally addresses one of the task's attached agents (${AGENT_ROLE_NAMES.join(', ')}); it defaults to the Do agent.`,
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        signal: { type: 'string', enum: ['confirm', 'cancel', 'retry', 'followUp'] },
        otherAttempts: { type: 'string', enum: ['keep', 'cancel'] },
        saveOtherAttemptsDefault: { type: 'boolean', description: 'Save the choice for this project; requires project:settings:write.' },
        text: { type: 'string' },
        role: { type: 'string', enum: [...AGENT_ROLE_NAMES] },
      },
      required: ['task_id', 'signal'],
    },
  },
  {
    name: 'reorder_queue',
    description: 'Prioritize a task in a merge queue domain.',
    parameters: { type: 'object', properties: { domain: { type: 'string' }, task_id: { type: 'string' } }, required: ['domain', 'task_id'] },
  },
  {
    name: 'propose_workflow_edit',
    description: 'Propose an edit to a workflow repo through the reviewed merge-only PR gate.',
    parameters: {
      type: 'object',
      properties: { project_id: { type: 'string' }, title: { type: 'string' }, repo: { type: 'string' }, branch: { type: 'string' }, target: { type: 'string' } },
      required: ['project_id', 'title', 'repo', 'branch', 'target'],
    },
  },
  // ─── cloud sandbox providers + execution policy ──────────────────────────
  {
    name: 'list_world_providers',
    description: 'List the cloud sandbox providers connected to an organization. Credentials are write-only and are never returned.',
    parameters: { type: 'object', properties: { organization_id: { type: 'string' } }, required: ['organization_id'] },
  },
  {
    name: 'connect_world_provider',
    description: `Connect or rotate an organization cloud sandbox provider. Requires organization:edit. The API key is stored in the encrypted ${BRAND} vault and never returned.`,
    parameters: {
      type: 'object',
      properties: {
        organization_id: { type: 'string' }, provider: { type: 'string', enum: ['e2b', 'daytona'] },
        api_key: { type: 'string' }, name: { type: 'string' },
        template: { type: 'string' }, snapshot: { type: 'string' }, image: { type: 'string' },
        desktop_template: { type: 'string' }, desktop_snapshot: { type: 'string' }, desktop_image: { type: 'string' },
        api_url: { type: 'string' }, target: { type: 'string' },
      },
      required: ['organization_id', 'provider'],
    },
  },
  {
    name: 'test_world_provider',
    description: 'Verify an organization cloud provider credential without creating a billable task world.',
    parameters: {
      type: 'object',
      properties: { organization_id: { type: 'string' }, provider: { type: 'string', enum: ['e2b', 'daytona'] } },
      required: ['organization_id', 'provider'],
    },
  },
  {
    name: 'disconnect_world_provider',
    description: 'Remove an organization cloud provider credential after all worlds using it are gone.',
    parameters: {
      type: 'object',
      properties: { organization_id: { type: 'string' }, provider: { type: 'string', enum: ['e2b', 'daytona'] } },
      required: ['organization_id', 'provider'],
    },
  },
  {
    name: 'get_execution_policy',
    description: 'Read an organization execution policy, or a project override plus its effective inherited policy.',
    parameters: {
      type: 'object',
      properties: { organization_id: { type: 'string' }, project_id: { type: 'string' } },
      required: ['organization_id'],
    },
  },
  {
    name: 'set_execution_policy',
    description: 'Set organization execution defaults or sparse project overrides. Only the fields you pass are changed; null project values restore organization inheritance.',
    parameters: {
      type: 'object',
      properties: {
        organization_id: { type: 'string' }, project_id: { type: 'string' },
        world_provider: { type: 'string' }, runner_pool_id: { type: 'string' },
        environment_flavor: { type: 'string', enum: ['headless', 'desktop'] },
        cpu: { type: 'number' }, memory_mb: { type: 'number' }, gpu: { type: 'number' },
        unrestricted_internet: { type: 'boolean' },
        allow_domains: { type: 'array', items: { type: 'string' } },
        allow_cidrs: { type: 'array', items: { type: 'string' } },
        monthly_budget_usd: { type: 'number' }, hibernate_after_days: { type: 'number' },
      },
      required: ['organization_id'],
    },
  },
  {
    name: 'find_task',
    description: 'Resolve a human-facing project-local task number (#100) to its canonical id. Returns a pointer {id, num, projectId} — pass that id to get_task.',
    parameters: { type: 'object', properties: { project_id: { type: 'string' }, number: { type: 'number' } }, required: ['project_id', 'number'] },
  },
  {
    name: 'list_agents',
    description: 'Discover the agent roles/sessions attached to a task.',
    parameters: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] },
  },
  {
    name: 'get_conversation',
    description: 'Read one attached agent conversation (do, merge, resolve, or confirm).',
    parameters: { type: 'object', properties: { task_id: { type: 'string' }, role: { type: 'string' } }, required: ['task_id'] },
  },
  {
    name: 'fork_agent',
    description: 'Branch an attached agent into an independent new task/session, optionally with a different provider/model. Defaults to the source task branch and unpublished checkpoint, or its merge target after landing. Set base to another branch for normal project initialization. The source remains untouched. reauthorize=true starts the fork with the grants the source task ended with (authorization level/scope and approved vault credentials), checked against your own authority.',
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'string' }, role: { type: 'string' }, title: { type: 'string' }, message: { type: 'string' },
        base: { type: 'string', description: 'Starting branch; defaults to the source task branch, or its merge target after landing. Changing it excludes unpublished source state.' }, target: { type: 'string' }, authorization_profile: { type: 'string' }, reauthorize: { type: 'boolean' },
        provider: { type: 'string', enum: ['claude', 'codex', 'opencode', 'kimi', 'grok', 'mock'] },
        model: { type: 'string' }, effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'] },
      },
      required: ['task_id', 'message'],
    },
  },
  {
    name: 'message_agent',
    description: 'Send a follow-up to an original or forked task agent; it is injected live when running.',
    parameters: { type: 'object', properties: { task_id: { type: 'string' }, role: { type: 'string' }, message: { type: 'string' } }, required: ['task_id', 'message'] },
  },
  {
    name: 'request_agent_action',
    description: `Ask another task agent to publish its branch in the background. Returns a durable request id immediately; ${BRAND} injects completion or failure into this conversation. Continue other work and do not poll.`,
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'string' }, role: { type: 'string' },
        action: { type: 'string', enum: ['publish_branch'] }, message: { type: 'string' },
      },
      required: ['task_id', 'action'],
    },
  },
  {
    name: 'cancel_agent_action',
    description: 'Withdraw one pending background collaboration requested by this task. This releases the Do-stage wait without cancelling the target task.',
    parameters: {
      type: 'object',
      properties: { request_id: { type: 'string' } },
      required: ['request_id'],
    },
  },
  {
    name: 'escalate_to_human',
    description:
      'Pause your current task at its exact stage and ask selected people, teams, or Avatars for input. ' +
      'Audience selectors: avatar:<id>, user:<id>, @team:<slug>, @creator, @owners, @project, or @all. ' +
      'Discover valid choices with platform_request(GET, "/api/agent/escalation-targets"). ' +
      'Calling this stops your current turn; the task resumes when a selected principal responds.',
    parameters: {
      type: 'object',
      properties: {
        audience: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          maxItems: 32,
          description: 'One or more person/team/Avatar routing selectors; any selected principal may respond.',
        },
        message: {
          type: 'string',
          minLength: 1,
          maxLength: 4_000,
          description: 'The concrete question or decision the human needs to answer.',
        },
        urgency: URGENCY_PARAMETER,
      },
      required: ['audience', 'message'],
    },
  },
  {
    name: 'request_permission',
    description:
      `Request exact ${BRAND} capabilities and/or additional projectIds for this task. Project expansion retains existing projects and applies the task authorization in added projects. The request appears in Approval Requests and is routed ` +
      'to selected people, teams, or Avatars. Audience selectors: avatar:<id>, user:<id>, @team:<slug>, @creator, @owners, @project, or @all. ' +
      'Discover choices with platform_request(GET, "/api/agent/escalation-targets"). Only a selected principal that already ' +
      'holds the requested capabilities and can grant the full task authorization across the expanded scope can approve. Do not request wildcards. An approval or denial resumes the task.',
    parameters: {
      type: 'object',
      properties: {
        capabilities: {
          type: 'array',
          items: { type: 'string' },
          minItems: 0,
          maxItems: 32,
          description: 'Exact capability names to add to this task, for example settings:read.',
        },
        projectIds: { type: 'array', items: { type: 'string' }, maxItems: 32,
          description: 'Additional project IDs in this organization. Existing projects are retained. Supply capabilities: [] for scope only.' },
        audience: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          maxItems: 32,
          description: 'One or more person/team/Avatar routing selectors; any selected capable principal may decide.',
        },
        reason: {
          type: 'string',
          minLength: 1,
          maxLength: 4_000,
          description: 'Why the task needs these capabilities (shown to the human).',
        },
        urgency: URGENCY_PARAMETER,
      },
      required: ['capabilities', 'audience', 'reason'],
    },
  },
  {
    name: 'publish_task_branch',
    description: 'Publish this task’s clean, committed Git branch so another agent can import it. Commit first.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'import_task_branch',
    description: 'Fetch another task’s published branch into a namespaced local ref for inspection, testing, cherry-picking, or merging.',
    parameters: { type: 'object', properties: { source_task_id: { type: 'string' } }, required: ['source_task_id'] },
  },
  {
    name: 'refresh_upstream',
    description: 'Fetch the latest upstream base/target branch into refs/remotes/origin. Optionally name another branch.',
    parameters: { type: 'object', properties: { branch: { type: 'string' } } },
  },
  {
    name: 'list_events',
    description: `Read durable ${BRAND} events for a task after an optional sequence number.`,
    parameters: { type: 'object', properties: { task_id: { type: 'string' }, since: { type: 'number' } }, required: ['task_id'] },
  },
  {
    name: 'list_github_actions_runs',
    description: 'List GitHub Actions workflow runs for a repository attached to this task’s project. Omit repository only when the project has one attached GitHub repository.',
    parameters: {
      type: 'object',
      properties: {
        repository: { type: 'string', description: 'Attached repository id, name, or owner/name.' },
        branch: { type: 'string' }, event: { type: 'string' },
        status: { type: 'string', enum: ['completed', 'action_required', 'cancelled', 'failure', 'neutral', 'skipped', 'stale', 'success', 'timed_out', 'in_progress', 'queued', 'requested', 'waiting', 'pending'] },
        workflow: { description: 'Numeric workflow id or file name such as deploy.yml.', anyOf: [{ type: 'string' }, { type: 'number' }] },
        page: { type: 'number' }, per_page: { type: 'number' },
      },
    },
  },
  {
    name: 'list_github_actions_workflows',
    description: 'Discover workflow ids, paths and enabled states in an attached repository. Paginated; requires github:actions:read.',
    parameters: { type: 'object', properties: {
      repository: { type: 'string' }, page: { type: 'number' }, per_page: { type: 'number' },
    } },
  },
  {
    name: 'inspect_github_actions_run',
    description: 'Inspect Actions evidence with github:actions:read. Default failure view preserves diagnostics. Use jobs for paginated steps/attempts, log with job_id for any conclusion and bounded tail output, artifacts for metadata, annotations with job_id for check diagnostics, or pending-deployments for current approval waits. Pin attempt for historical jobs/logs. headSha and success/skipped status do not prove deployed code; verify explicit target, readiness, completion and rollback evidence. Credentials and signed URLs stay host-side.',
    parameters: { type: 'object', properties: {
      repository: { type: 'string', description: 'Attached repository id, name, or owner/name.' },
      run_id: { type: 'number' },
      view: { type: 'string', enum: ['failure', 'jobs', 'log', 'artifacts', 'annotations', 'pending-deployments'] },
      attempt: { type: 'number' }, job_id: { type: 'number' }, page: { type: 'number' }, per_page: { type: 'number' },
      offset_lines: { type: 'number', description: 'Page backwards from the end using nextOffsetLines, within retainedLines.' },
      tail_lines: { type: 'number', description: 'Log tail lines, default 100, maximum 500.' },
      max_chars: { type: 'number', description: 'Log output characters, default 16000, maximum 32000. Check tailComplete and truncation flags.' },
    }, required: ['run_id'] },
  },
  {
    name: 'manage_github_actions_run',
    description: 'Rerun failed jobs, rerun a whole run, or cancel a run. Requires github:actions:write; request that exact capability if the task lacks it.',
    parameters: { type: 'object', properties: {
      repository: { type: 'string', description: 'Attached repository id, name, or owner/name.' },
      run_id: { type: 'number' }, action: { type: 'string', enum: ['rerun-failed', 'rerun', 'cancel'] },
    }, required: ['run_id', 'action'] },
  },
  {
    name: 'dispatch_github_actions_workflow',
    description: 'Dispatch an Actions workflow on a ref. Requires github:actions:write; request that exact capability if the task lacks it.',
    parameters: { type: 'object', properties: {
      repository: { type: 'string', description: 'Attached repository id, name, or owner/name.' },
      workflow: { description: 'Numeric workflow id or file name such as deploy.yml.', anyOf: [{ type: 'string' }, { type: 'number' }] },
      ref: { type: 'string' }, inputs: { type: 'object', additionalProperties: { anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }] } },
    }, required: ['workflow', 'ref'] },
  },
  {
    name: 'describe_platform',
    description: 'Describe the complete administrative API exposed by platform_request.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'platform_request',
    description: `Call any authenticated ${BRAND} /api/* route (projects, settings, users, credentials, payments, review actions, diagnostics, and more). Authorization is always enforced, and routes the gateway answers before its session gate (sign-in/sign-up, webhooks, OAuth callbacks) are refused. Call describe_platform when unsure.`,
    parameters: {
      type: 'object',
      properties: {
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
        path: { type: 'string' },
        body: PLATFORM_REQUEST_BODY_SCHEMA,
      },
      required: ['method', 'path'],
    },
  },
  {
    name: 'open_pr',
    description:
      'Do agents ONLY. Open (or refresh) this task\'s pull request and send its exact committed proposal to Review. Call this only as your final action after the requested work is truly complete, all intended files are committed, unwanted files are ignored or removed, and relevant tests pass. Ending a turn or asking a human for input does not open a PR.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'signal_completion',
    description: 'Optionally attach a structured completion summary. A successful provider turn already establishes completion; this tool is not required.',
    parameters: {
      type: 'object',
      properties: { summary: { type: 'string' } },
    },
  },
  {
    name: 'resolve_decision',
    description:
      'Resolve agents ONLY. Report how to get the task back on track — do NOT finish the task yourself. action: "resume" (you fixed the cause; continue the interrupted agent), "retryStage" (re-run the failed step fresh), "gotoStage" (rewind to an earlier stage, optionally editing params), "parkUntil" (wait for an event then act), or "escalate" (you cannot fix it; hand to a human with a reason). Calling this ends your turn.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['resume', 'retryStage', 'gotoStage', 'parkUntil', 'escalate'] },
        stage: { type: 'string', description: 'For gotoStage: earlier stage to return to (setup/do/review/pr/merge).' },
        reason: { type: 'string', description: 'For escalate: why a human is needed.' },
        params: { type: 'object', description: 'For gotoStage: param edits to apply on rewind, e.g. {"target":"release"}.' },
      },
      required: ['action'],
    },
  },
  {
    name: 'confirm_decision',
    description:
      'Confirm agents, or a Do agent explicitly asked by the workflow to perform final exact-candidate verification. Review the already-open proposal; do NOT keep building it in this turn. action: "confirm" (accept the candidate), "revise" (return specific repair feedback in `text`), or "reject" (require human Review when the workflow says so). Calling this ends your turn.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['confirm', 'revise', 'reject'] },
        otherAttempts: { type: 'string', enum: ['keep', 'cancel'], description: 'On confirmation, keep sibling attempts running and eligible to merge, or cancel them. The first attempt entering Merge fixes this choice for the group.' },
        text: { type: 'string', description: 'For revise: the feedback the Do agent should act on. For reject: why the work is being cancelled.' },
      },
      required: ['action'],
    },
  },
];

/** The world file/shell tools the Claude Agent SDK provides natively (Read/Write/Bash),
 *  so its in-process MCP server must NOT re-register them. Everything else in
 *  TOOL_SCHEMAS is a platform tool that the SDK path DOES expose. */
export const SDK_NATIVE_TOOLS = new Set(['bash', 'read_file', 'write_file']);

/** Platform (non-file/shell) tools — the SINGLE source of truth for what every agent
 *  adapter exposes. Both the Messages-API path (all of TOOL_SCHEMAS) and the Agent-SDK
 *  path (this list, minted natively for Read/Write/Bash) derive from it, so the two can
 *  never drift — the drift that hid `respond_to_sub_task` from Claude-Code agents. */
export const PLATFORM_TOOL_SCHEMAS: ToolSchema[] = TOOL_SCHEMAS.filter((t) => !SDK_NATIVE_TOOLS.has(t.name));

/** Turn-local controls that must mutate the current activity result. Durable
 * platform operations are served by the gateway-backed stdio `karmax` MCP. */
export const SDK_CONTROL_TOOL_NAMES = new Set([
  'create_review_info',
  'create_sub_task',
  'create_branch',
  'respond_to_sub_task',
  'raise_to_parent',
  'wait_for_subtasks',
  'start_job',
  'pause',
  'stop_job',
  'request_spend',
  'fill_payment_card',
  'open_pr',
  'signal_completion',
  'resolve_decision',
  'confirm_decision',
]);

export const SDK_CONTROL_TOOL_SCHEMAS: ToolSchema[] = PLATFORM_TOOL_SCHEMAS.filter((tool) =>
  SDK_CONTROL_TOOL_NAMES.has(tool.name),
);

/** Returns name → executor for the platform tools, bound to a world + context. */
export function platformToolHandlers(
  world: World,
  ctx: PlatformToolContext,
  /** Read per command: project secrets can change mid-turn. */
  workEnv?: () => Record<string, string>,
): Record<string, (args: any) => Promise<string>> {
  const platformRequest = (method: string, requestPath: string, body?: unknown) => {
    if (!ctx.platformRequest) throw new Error(`${BRAND} gateway is unavailable to this agent`);
    return ctx.platformRequest(method, requestPath, body);
  };
  /** `pause`'s needs-input fields: who to ask, what, and how loudly. Routes are
   * checked against the ones escalate_to_human offers, so a typo cannot park the
   * task on an ask nobody receives. Avatars answer through escalate_to_human. */
  const pauseInput = async (args: any): Promise<AgentWait['needsInput']> => {
    const asked = args?.message !== undefined || args?.audience !== undefined || args?.urgency !== undefined;
    if (args?.needs_input !== true) {
      if (asked) throw new Error('message, audience and urgency apply only with needs_input: true');
      return undefined;
    }
    const message = args?.message === undefined ? undefined : String(args.message).trim();
    if (message !== undefined && !message) throw new Error('message must not be empty');
    if (message && [...message].length > 4_000) throw new Error('message must be at most 4000 characters');
    let audience: string[] | undefined;
    if (args?.audience !== undefined) {
      audience = [...new Set((Array.isArray(args.audience) ? args.audience : [args.audience])
        .map((selector: unknown) => String(selector).trim()).filter(Boolean))] as string[];
      if (!audience.length) throw new Error('audience must name at least one person or team');
      if (audience.length > 32) throw new Error('at most 32 audience selectors may be used');
      const avatars = audience.filter((selector) => selector.startsWith('avatar:'));
      if (avatars.length) throw new Error(`${avatars.join(', ')}: ask an Avatar with escalate_to_human`);
      if (ctx.platformRequest) {
        const targets = await platformRequest('GET', '/api/agent/escalation-targets') as {
          users?: Array<{ selector: string }>; teams?: Array<{ selector: string }>; special?: Array<{ selector: string }>;
        };
        const known = new Set([...targets.users ?? [], ...targets.teams ?? [], ...targets.special ?? []].map((t) => t.selector));
        const unknown = audience.filter((selector) => !known.has(selector));
        if (unknown.length) throw new Error(`no such route: ${unknown.join(', ')}. Valid routes: ${[...known].join(', ') || 'none'}`);
      }
    }
    const urgency = URGENCY_LEVELS.includes(args?.urgency) ? args.urgency as Urgency : undefined;
    return { ...(message ? { message } : {}), ...(audience ? { audience } : {}), ...(urgency ? { urgency } : {}) };
  };
  const handlers: Record<string, (args: any) => Promise<string>> = {
    async bash(args) {
      const cmd = String(args?.command ?? '');
      const env = workEnv?.();
      const r = await boundedExec(world, cmd, { maxBytes: 16_000, overflow: 'tail', timeoutMs: 120_000, ...(env ? { env } : {}) });
      ctx.emit(`$ ${cmd}`);
      const out = `exit ${r.code}\n${r.stdout}${r.stderr}`;
      return out;
    },
    async read_file(args) {
      try {
        // A longer file still fills the result, so a huge one never has to
        // reach this process whole (AD-1).
        return truncate((await readWorldFilePrefix(world, String(args?.path ?? ''), READ_FILE_MAX_BYTES)).toString('utf8'));
      } catch (e: any) {
        return `error: ${e?.message ?? e}`;
      }
    },
    async write_file(args) {
      await world.writeFile(String(args?.path ?? ''), String(args?.content ?? ''));
      ctx.emit(`wrote ${args?.path}`);
      return `wrote ${args?.path}`;
    },
    async create_review_info(args) {
      // The runtime re-checks the accumulated total; either rejection goes back
      // to the agent as a correctable tool result, never a lost attachment.
      try {
        await ctx.createReviewInfo(validateReviewInfoCall({
          caption: args?.caption,
          actions: args?.actions,
          summary: args?.summary,
          links: args?.links,
          diff: args?.diff,
          html: args?.html,
        }));
      } catch (error) {
        if (error instanceof ReviewInfoRejected || (error as Error)?.name === 'ReviewInfoRejected')
          return `review info rejected: ${(error as Error).message}`;
        throw error;
      }
      return 'review info recorded';
    },
    async create_sub_task(args) {
      await ctx.createSubTask({ title: String(args?.title ?? 'sub-task'), prompt: String(args?.prompt ?? ''),
        ...(args?.params !== undefined ? { params: args.params } : {}) });
      return 'sub-task queued: it starts when this turn ends (branches off your work; you are its confirmer)';
    },
    async respond_to_sub_task(args) {
      const action = String(args?.action ?? '');
      if (!['open_pr', 'confirm', 'comment', 'retry', 'cancel'].includes(action))
        return 'invalid action — use open_pr | confirm | comment | retry | cancel';
      await ctx.respondToSubTask({
        childTaskId: args?.child_task_id ? String(args.child_task_id) : undefined,
        action: action as 'open_pr' | 'confirm' | 'comment' | 'retry' | 'cancel',
        text: args?.text ? String(args.text) : undefined,
      });
      return `${action} queued for sub-task${args?.child_task_id ? ` ${args.child_task_id}` : 's'}: delivered when this turn ends`;
    },
    async raise_to_parent(args) {
      const type = String(args?.type ?? '');
      if (!['needs_info', 'needs_permission', 'needs_confirmation', 'blocked'].includes(type))
        return 'invalid type — use needs_info | needs_permission | needs_confirmation | blocked';
      await ctx.raiseToParent({ type: type as 'needs_info' | 'needs_permission' | 'needs_confirmation' | 'blocked', detail: args?.detail ? String(args.detail) : undefined });
      return `raised to parent: ${type}`;
    },
    async wait_for_subtasks() {
      await ctx.waitForSubtasks();
      return 'waiting for sub-tasks to finish (or raise)';
    },
    async start_job(args) {
      const command = String(args?.command ?? '').trim();
      if (!command) return 'error: command is required';
      try {
        const env = workEnv?.();
        const job = await startJob(world, { command, ...(args?.cwd ? { cwd: String(args.cwd) } : {}),
          ...(args?.name ? { name: String(args.name) } : {}), ...(env ? { env } : {}) });
        await ctx.jobStarted(job.id);
        ctx.emit(`$ ${command} (job ${job.id})`);
        return `Started job ${job.id}${job.name ? ` (${job.name})` : ''}. Log: ${job.log}\nIt keeps running after this turn. Call pause with jobs ["${job.id}"] to be resumed when it finishes.`;
      } catch (e: any) {
        return `error: ${e?.message ?? e}`;
      }
    },
    async stop_job(args) {
      const ids = Array.isArray(args?.jobs) ? [...new Set(args.jobs.map((id: unknown) => String(id)))] as string[] : [];
      if (!ids.length) return 'error: jobs is required';
      try {
        const before = await jobStatuses(world, ids);
        const missing = before.filter((job) => job.state === 'missing').map((job) => job.id);
        if (missing.length) return `error: no such job: ${missing.join(', ')}`;
        const running = before.filter((job) => job.state === 'running').map((job) => job.id);
        // An exited job may still have left processes running (`server &`).
        const stops = new Map((await stopJobs(world, ids)).map((stop) => [stop.id, stop]));
        const after = new Map((await jobStatuses(world, running)).map((job) => [job.id, job.state]));
        return before.map(({ id, state }) => {
          const { processes = 0, survivors = [] } = stops.get(id) ?? {};
          if (survivors.length) return `${id}: ${survivors.length === 1 ? 'process' : 'processes'} ${survivors.join(', ')} survived SIGKILL.`;
          if (running.includes(id)) return after.get(id) === 'running' ? `${id} is still running.` : `Stopped ${id}.`;
          return processes
            ? `${id} had already ${state === 'exited' ? 'exited' : 'stopped'}; ended the ${processes} ${processes === 1 ? 'process' : 'processes'} it left running.`
            : `${id} had already stopped.`;
        }).join('\n');
      } catch (e: any) {
        return `error: ${e?.message ?? e}`;
      }
    },
    async pause(args) {
      const minutes = Number(args?.minutes);
      if (!Number.isFinite(minutes) || minutes < 1 || minutes > MAX_WAIT_MINUTES)
        return `error: minutes must be between 1 and ${MAX_WAIT_MINUTES}`;
      const requested = Array.isArray(args?.jobs) ? [...new Set(args.jobs.map((id: unknown) => String(id)))] as string[] : [];
      let jobs: string[] = [];
      let jobNames: string[] = [];
      let unlisted: string[];
      try {
        if (requested.length) {
          const statuses = await jobStatuses(world, requested, { tailLines: 20 });
          const missing = statuses.filter((job) => job.state === 'missing').map((job) => job.id);
          if (missing.length) return `error: no such job: ${missing.join(', ')}`;
          const running = statuses.filter((job) => job.state === 'running');
          jobs = running.map((job) => job.id);
          jobNames = running.flatMap((job) => job.name ? [job.name] : []);
          // Nothing left to wait for: hand the results back now, no turn needed.
          if (!jobs.length) return `Every job has already finished — nothing to wait for.\n\n${describeJobs(statuses)}`;
        }
        unlisted = (await jobStatuses(world, await listJobs(world)))
          .filter((job) => job.state === 'running' && !jobs.includes(job.id)).map((job) => job.id);
      } catch (e: any) {
        return `error: ${e?.message ?? e}`;
      }
      if (unlisted.length)
        return `error: ${unlisted.join(', ')} ${unlisted.length > 1 ? 'are' : 'is'} still running. Pass ${unlisted.length > 1 ? 'them' : 'it'} in jobs: a pause without ${unlisted.length > 1 ? 'them' : 'it'} lets the world be suspended, which freezes ${unlisted.length > 1 ? 'them' : 'it'}. You are still resumed after minutes at the latest.`;
      let needsInput: AgentWait['needsInput'];
      try { needsInput = await pauseInput(args); }
      catch (e: any) { return `error: ${e?.message ?? e}`; }
      try {
        await ctx.requestWait({ minutes: Math.round(minutes), ...(jobs.length ? { jobs } : {}),
          ...(jobNames.length ? { jobNames } : {}), ...(needsInput ? { needsInput } : {}) });
      }
      catch (e: any) { return `error: ${e?.message ?? e}`; }
      if (needsInput) {
        const who = needsInput.audience?.join(', ') ?? 'whoever answers this task\'s questions';
        return `Asking ${who}. End your turn now${needsInput.message ? '' : ' with the question as your final response'}; you will be resumed with their answer, ${jobs.length ? `when ${jobs.join(', ')} ${jobs.length > 1 ? 'finish' : 'finishes'}, ` : ''}or after ${Math.round(minutes)} min to carry on without it.`;
      }
      return jobs.length
        ? `Waiting for ${jobNames.length === jobs.length ? jobNames.join(', ') : jobs.join(', ')} (at most ${Math.round(minutes)} min). End your turn now; you will be resumed when ${jobs.length > 1 ? 'they finish' : 'it finishes'}, a message arrives, or the time is up.`
        : `Pausing for ${Math.round(minutes)} min. End your turn now; you will be resumed then, or sooner if a message arrives.`;
    },
    async create_branch(args) {
      try {
        const added = await ctx.addCheckout({
          name: String(args?.name ?? ''),
          from: args?.from ? String(args.from) : undefined,
          base: args?.base ? String(args.base) : undefined,
          target: args?.target ? String(args.target) : undefined,
        });
        ctx.emit(`branch ${added.branch} checked out at ${added.root}`);
        return `branch "${added.branch}" is checked out at ${added.root} — work in that directory for the change`
          + ` belonging to this pull request, and commit it there. It is reviewed and merged with the rest of this task.`;
      } catch (e: any) {
        // A refusal here is informational, not a turn failure: the agent can
        // simply carry on in the branch it already has.
        return `could not create the branch: ${e?.message ?? e}`;
      }
    },
    async save_skill(args) {
      const skill = { name: String(args?.name ?? 'skill'), content: String(args?.content ?? '') };
      // The gateway saves it for the organization or the task's project,
      // depending on the task's authority; the turn result only records it.
      const saved = await platformRequest('POST', '/api/skills', skill) as { scope?: string } | undefined;
      await ctx.saveSkill(skill);
      return saved?.scope === 'organization' ? 'skill saved for your whole organization'
        : saved?.scope === 'project' ? 'skill saved to your task\'s project' : 'skill saved';
    },
    async read_wiki(args) {
      const scope = args?.scope === 'organization' ? 'organizations' : 'projects';
      const id = encodeURIComponent(String(args?.id ?? ''));
      return JSON.stringify(await platformRequest('GET', `/api/${scope}/${id}/wiki?path=${encodeURIComponent(String(args?.path ?? ''))}`));
    },
    async search_wiki(args) {
      const scope = args?.scope === 'organization' ? 'organizations' : 'projects';
      const id = encodeURIComponent(String(args?.id ?? ''));
      return JSON.stringify(await platformRequest('GET', `/api/${scope}/${id}/wiki/search?q=${encodeURIComponent(String(args?.query ?? ''))}`));
    },
    async request_spend(args) {
      const r = await ctx.requestSpend({
        amount: Number(args?.amount ?? 0),
        cardName: args?.card_name ? String(args.card_name) : undefined,
        cardId: args?.card_id ? String(args.card_id) : undefined,
        merchant: args?.merchant ? String(args.merchant) : undefined,
        why: args?.why ? String(args.why) : undefined,
      });
      return JSON.stringify(r);
    },
    async fill_payment_card(args) {
      if (!ctx.fillPaymentCard) throw new Error('secure payment-card fill is unavailable');
      return JSON.stringify(await ctx.fillPaymentCard({
        requestId: String(args?.request_id ?? ''),
        selectors: {
          number: String(args?.number_selector ?? ''),
          cvc: String(args?.cvc_selector ?? ''),
          expiry: args?.expiry_selector ? String(args.expiry_selector) : undefined,
          expMonth: args?.exp_month_selector ? String(args.exp_month_selector) : undefined,
          expYear: args?.exp_year_selector ? String(args.exp_year_selector) : undefined,
          line1: args?.line1_selector ? String(args.line1_selector) : undefined,
          city: args?.city_selector ? String(args.city_selector) : undefined,
          postalCode: args?.postal_code_selector ? String(args.postal_code_selector) : undefined,
          country: args?.country_selector ? String(args.country_selector) : undefined,
        },
      }));
    },
    async list_connections() { return JSON.stringify(await platformRequest('GET', '/api/connections')); },
    async request_connection(args) { return JSON.stringify(await platformRequest('POST', '/api/connections/request', { mcp: args?.mcp, toolkit: args?.toolkit, why: args?.why })); },
    async search_connection_tools(args) { return JSON.stringify(await platformRequest('GET', `/api/connections/${encodeURIComponent(String(args?.connection_id ?? ''))}/tools?search=${encodeURIComponent(String(args?.search ?? ''))}`)); },
    async execute_connection_tool(args) { return JSON.stringify(await platformRequest('POST', `/api/connections/${encodeURIComponent(String(args?.connection_id ?? ''))}/execute`, { tool: args?.tool, arguments: args?.arguments })); },
    async list_credentials() {
      return JSON.stringify(await platformRequest('GET', '/api/vault/available'));
    },
    async request_credential(args) {
      const r: any = await platformRequest('POST', '/api/vault/requests', {
        itemId: args?.item_id, domain: args?.domain, mode: args?.mode, kind: args?.kind, why: args?.why ? String(args.why) : undefined,
        ...(args?.urgency ? { urgency: String(args.urgency) } : {}),
      });
      // Mirror request_spend: a parked request surfaces at the Review gate.
      if (r?.status === 'needs_approval' || r?.status === 'not_in_vault') {
        await ctx.createReviewInfo({ summary: `Credential access requested: ${args?.item_id ?? args?.domain ?? ''} (${r.status === 'not_in_vault' ? 'not in the vault — add it or ask me to create the account' : 'approval needed'}). ${args?.why ?? ''}`.slice(0, MAX_REVIEW_TEXT_LENGTH) });
      }
      return JSON.stringify(r);
    },
    async fill_credential(args) {
      return JSON.stringify(await platformRequest('POST', '/api/vault/fill', {
        itemId: args?.item_id, domain: args?.domain, field: args?.field,
        selector: String(args?.selector ?? ''),
      }));
    },
    async get_credential(args) {
      return JSON.stringify(await platformRequest('POST', '/api/vault/resolve', {
        itemId: args?.item_id, domain: args?.domain, field: args?.field,
      }));
    },
    async store_credential(args) {
      return JSON.stringify(await platformRequest('POST', '/api/vault/store', {
        id: args?.id, type: args?.type, label: args?.label, domains: args?.domains,
        username: args?.username, envVar: args?.env_var, secrets: args?.secrets,
      }));
    },
    async verify_resource_revision(args) {
      const projectId = encodeURIComponent(String(args?.project_id ?? ''));
      const resourceId = encodeURIComponent(String(args?.resource_id ?? ''));
      const revisionId = encodeURIComponent(String(args?.revision_id ?? ''));
      const query = new URLSearchParams({ offset: String(args?.offset ?? 0), limit: String(args?.limit ?? 100) });
      return JSON.stringify(await platformRequest('GET',
        `/api/projects/${projectId}/resources/${resourceId}/revisions/${revisionId}/verify?${query}`));
    },
    async propose_project_resource(args) {
      const sources = Number(Boolean(args?.path)) + Number(Boolean(args?.vault_item_id));
      const targets = Number(Boolean(args?.target_path)) + Number(Boolean(args?.target_environment))
        + Number(Boolean(args?.target_service));
      if (sources !== 1) throw new Error('provide exactly one of path or vault_item_id');
      if (targets !== 1) throw new Error('provide exactly one target_path, target_environment, or target_service');
      const result = await platformRequest('POST', '/api/agent/resource-candidates', {
        source: args.path ? { kind: 'path', path: String(args.path) }
          : { kind: 'vault-item', itemId: String(args.vault_item_id), ...(args.field ? { field: String(args.field) } : {}) },
        name: String(args.name ?? ''), driver: args.driver, access: args.access, publish: args.publish,
        target: args.target_path ? { kind: 'path', path: String(args.target_path) }
          : args.target_service ? { kind: 'service', name: String(args.target_service) }
            : { kind: 'environment', name: String(args.target_environment) },
      });
      await ctx.createReviewInfo({ summary: `Project resource proposed: ${String(args.name ?? '')}. Included on confirmation unless excluded.`.slice(0, MAX_REVIEW_TEXT_LENGTH) });
      return JSON.stringify(result);
    },
    async check_agent_mail(args) {
      const q = new URLSearchParams();
      if (args?.match) q.set('match', String(args.match));
      if (args?.since) q.set('since', String(args.since));
      const org = encodeURIComponent(String(args?.organization_id ?? ''));
      return JSON.stringify(await platformRequest('GET', `/api/organizations/${org}/agent-mail${q.toString() ? `?${q}` : ''}`));
    },
    async enroll_passkey(args) {
      return JSON.stringify(await platformRequest('POST', '/api/vault/passkey/enroll', { domain: args?.domain }));
    },
    async save_passkey(args) {
      return JSON.stringify(await platformRequest('POST', '/api/vault/passkey/save', {
        authenticatorId: String(args?.authenticator_id ?? ''), label: args?.label, domains: args?.domains, username: args?.username,
      }));
    },
    async use_passkey(args) {
      return JSON.stringify(await platformRequest('POST', '/api/vault/passkey/login', { itemId: args?.item_id, domain: args?.domain }));
    },
    async save_session(args) {
      return JSON.stringify(await platformRequest('POST', '/api/vault/session/save', {
        domain: args?.domain, itemId: args?.item_id, label: args?.label, username: args?.username, exclusive: args?.exclusive,
      }));
    },
    async use_session(args) {
      return JSON.stringify(await platformRequest('POST', '/api/vault/session/use', { itemId: args?.item_id, domain: args?.domain, why: args?.why }));
    },
    // ─── task list operations (mirroring the platform MCP server) ─────────
    async create_task(args) {
      const projectId = encodeURIComponent(String(args?.project_id ?? ''));
      // `priority`/`tags` are sent WITH the create rather than as follow-up
      // edits: those follow-ups needed `task:edit`, which the bundled Do role
      // does not hold, so a tagged create half-succeeded and then returned a
      // permission error for a task that already existed. An unknown priority
      // name is reported rather than silently dropped (`indexOf` → -1).
      let priority: number | undefined;
      if (args?.priority !== undefined) {
        const index = PRIORITY_NAMES.indexOf(String(args.priority) as any);
        if (index < 0) return `error: unknown priority "${String(args.priority)}" (expected one of ${PRIORITY_NAMES.join(', ')})`;
        if (index > 0) priority = index;
      }
      const tags = Array.isArray(args?.tags) && args.tags.length ? args.tags : undefined;
      const created: any = await platformRequest('POST', `/api/projects/${projectId}/tasks`, {
        title: args?.title, prompt: args?.prompt, workflow: args?.workflow,
        wikiContext: args?.wiki_context, draft: args?.draft, params: args?.params,
        ...(priority !== undefined ? { priority } : {}), ...(tags ? { tags } : {}),
      });
      return JSON.stringify(created);
    },
    async get_task(args) {
      return JSON.stringify(await platformRequest('GET', `/api/tasks/${encodeURIComponent(String(args?.task_id ?? ''))}`));
    },
    async list_tasks(args) {
      const listed = await platformRequest('GET', `/api/projects/${encodeURIComponent(String(args?.project_id ?? ''))}/tasks`) as any[];
      return JSON.stringify((listed ?? []).map((t) => ({ id: t.id, title: t.title, workflow: t.workflow })));
    },
    async search_tasks(args) {
      if (!args?.project_id === !args?.organization_id) return 'pass exactly one of project_id or organization_id';
      if (args?.organization_id) {
        return JSON.stringify(compactOrganizationSearch(await platformRequest('GET',
          `/api/organizations/${encodeURIComponent(String(args.organization_id))}/search?q=${encodeURIComponent(String(args?.query ?? ''))}`) as { tags?: unknown[] }));
      }
      const projectId = encodeURIComponent(String(args?.project_id ?? ''));
      const [result, tags] = await Promise.all([
        platformRequest('GET', `/api/projects/${projectId}/search?q=${encodeURIComponent(String(args?.query ?? ''))}`),
        platformRequest('GET', `/api/projects/${projectId}/tags`),
      ]);
      return JSON.stringify(compactSearch(result, tags as any[]));
    },
    async list_tags(args) {
      const tags = await platformRequest('GET', `/api/projects/${encodeURIComponent(String(args?.project_id ?? ''))}/tags`);
      return JSON.stringify(compactTags(tags as any[]));
    },
    async tag_task(args) {
      return JSON.stringify(await platformRequest('POST', `/api/tasks/${encodeURIComponent(String(args?.task_id ?? ''))}/tag`,
        { add: args?.add, remove: args?.remove }));
    },
    async set_task_priority(args) {
      const priority = PRIORITY_NAMES.indexOf(String(args?.priority ?? '') as any);
      if (priority < 0) return `invalid priority — use one of ${PRIORITY_NAMES.join(', ')}`;
      await platformRequest('PUT', `/api/tasks/${encodeURIComponent(String(args?.task_id ?? ''))}/priority`, { priority });
      return `priority set to ${args?.priority}`;
    },
    async signal_task(args) {
      await platformRequest('POST', `/api/tasks/${encodeURIComponent(String(args?.task_id ?? ''))}/signal`,
        { signal: args?.signal, text: args?.text, role: args?.role, otherAttempts: args?.otherAttempts, saveOtherAttemptsDefault: args?.saveOtherAttemptsDefault });
      return 'signalled';
    },
    async reorder_queue(args) {
      await platformRequest('POST', '/api/queue/prioritize', { domain: args?.domain, taskId: args?.task_id });
      return 'reordered';
    },
    async propose_workflow_edit(args) {
      return JSON.stringify(await platformRequest('POST',
        `/api/projects/${encodeURIComponent(String(args?.project_id ?? ''))}/propose-workflow-edit`,
        { title: args?.title, repo: args?.repo, branch: args?.branch, target: args?.target }));
    },
    // ─── cloud sandbox providers + execution policy ───────────────────────
    async list_world_providers(args) {
      return JSON.stringify(await platformRequest('GET', `/api/organizations/${encodeURIComponent(String(args?.organization_id ?? ''))}/world-providers`));
    },
    async connect_world_provider(args) {
      const org = encodeURIComponent(String(args?.organization_id ?? ''));
      return JSON.stringify(await platformRequest('PUT', `/api/organizations/${org}/world-providers/${encodeURIComponent(String(args?.provider ?? ''))}`, {
        apiKey: args?.api_key, name: args?.name,
        config: { template: args?.template, snapshot: args?.snapshot, image: args?.image,
          desktopTemplate: args?.desktop_template, desktopSnapshot: args?.desktop_snapshot, desktopImage: args?.desktop_image,
          apiUrl: args?.api_url, target: args?.target },
      }));
    },
    async test_world_provider(args) {
      const org = encodeURIComponent(String(args?.organization_id ?? ''));
      return JSON.stringify(await platformRequest('POST', `/api/organizations/${org}/world-providers/${encodeURIComponent(String(args?.provider ?? ''))}/test`, {}));
    },
    async disconnect_world_provider(args) {
      const org = encodeURIComponent(String(args?.organization_id ?? ''));
      return JSON.stringify(await platformRequest('DELETE', `/api/organizations/${org}/world-providers/${encodeURIComponent(String(args?.provider ?? ''))}`));
    },
    async get_execution_policy(args) {
      return JSON.stringify(await platformRequest('GET', args?.project_id
        ? `/api/projects/${encodeURIComponent(String(args.project_id))}/execution-policy`
        : `/api/organizations/${encodeURIComponent(String(args?.organization_id ?? ''))}/execution-policy`));
    },
    async set_execution_policy(args) {
      const projectId = args?.project_id ? String(args.project_id) : undefined;
      const url = projectId
        ? `/api/projects/${encodeURIComponent(projectId)}/execution-policy`
        : `/api/organizations/${encodeURIComponent(String(args?.organization_id ?? ''))}/execution-policy`;
      const policy: Record<string, unknown> = {};
      if (args?.world_provider !== undefined) policy.worldProvider = args.world_provider;
      if (args?.runner_pool_id !== undefined) policy.runnerPoolId = args.runner_pool_id;
      if (args?.environment_flavor !== undefined) policy.environment = { flavor: args.environment_flavor };
      if (args?.monthly_budget_usd !== undefined)
        policy.monthlyBudgetMicros = args.monthly_budget_usd == null ? null : Math.round(Number(args.monthly_budget_usd) * 1e6);
      if (args?.hibernate_after_days !== undefined)
        policy.hibernateAfterMs = args.hibernate_after_days == null ? null : Math.round(Number(args.hibernate_after_days) * 86_400_000);
      // Sparse by contract: `network` is replaced wholesale by the store, so a
      // partial change is merged against the policy currently in force rather
      // than silently clearing the fields the caller did not mention.
      const wantsResources = args?.cpu !== undefined || args?.memory_mb !== undefined || args?.gpu !== undefined;
      const wantsNetwork = args?.unrestricted_internet !== undefined || args?.allow_domains !== undefined || args?.allow_cidrs !== undefined;
      if (wantsResources || wantsNetwork) {
        const current: any = await platformRequest('GET', url).catch(() => undefined);
        // Two response shapes: the project route answers `{override, …}`, the
        // organization route answers the BARE policy (src/gateway/server.ts).
        // Reading only `.organization` made the org-scoped base `{}`, so the
        // merge discarded the live policy instead of preserving it.
        const base = (projectId ? current?.override : (current?.organization ?? current)) ?? {};
        if (wantsResources) {
          const resources: Record<string, unknown> = { ...(base.resources ?? {}) };
          if (args?.cpu !== undefined) resources.cpu = args.cpu;
          if (args?.memory_mb !== undefined) resources.memoryMb = args.memory_mb;
          if (args?.gpu !== undefined) resources.gpu = args.gpu;
          policy.resources = resources;
        }
        if (wantsNetwork) {
          const network: Record<string, unknown> = { ...(base.network ?? {}) };
          if (args?.unrestricted_internet !== undefined) network.unrestricted = args.unrestricted_internet;
          if (args?.allow_domains !== undefined) network.allowDomains = args.allow_domains;
          if (args?.allow_cidrs !== undefined) network.allowCidrs = args.allow_cidrs;
          policy.network = network;
        }
      }
      return JSON.stringify(await platformRequest('PUT', url, projectId ? { override: policy } : { policy }));
    },
    async find_task(args) {
      return JSON.stringify(await platformRequest('GET', `/api/projects/${encodeURIComponent(String(args?.project_id ?? ''))}/tasks/by-num/${Number(args?.number)}`));
    },
    async list_agents(args) {
      return JSON.stringify(await platformRequest('GET', `/api/tasks/${encodeURIComponent(String(args?.task_id ?? ''))}/agents`));
    },
    async get_conversation(args) {
      const role = encodeURIComponent(String(args?.role ?? 'do'));
      return JSON.stringify(await platformRequest('GET', `/api/tasks/${encodeURIComponent(String(args?.task_id ?? ''))}/conversation?role=${role}`));
    },
    async fork_agent(args) {
      const taskId = encodeURIComponent(String(args?.task_id ?? ''));
      return JSON.stringify(await platformRequest('POST', `/api/tasks/${taskId}/fork-agent`, {
        role: args?.role ?? 'do', title: args?.title, message: args?.message, base: args?.base, target: args?.target,
        authorizationProfile: args?.authorization_profile, reauthorize: args?.reauthorize === true,
        provider: args?.provider, model: args?.model, effort: args?.effort,
      }));
    },
    async message_agent(args) {
      const taskId = encodeURIComponent(String(args?.task_id ?? ''));
      await platformRequest('POST', `/api/tasks/${taskId}/messages`, { role: args?.role ?? 'do', text: args?.message });
      return 'message delivered';
    },
    async request_agent_action(args) {
      return JSON.stringify(await platformRequest('POST', '/api/agent/collaboration/request', {
        taskId: String(args?.task_id ?? ''),
        role: args?.role ? String(args.role) : 'do',
        action: String(args?.action ?? ''),
        message: args?.message ? String(args.message) : undefined,
      }));
    },
    async cancel_agent_action(args) {
      const requestId = encodeURIComponent(String(args?.request_id ?? ''));
      return JSON.stringify(await platformRequest('POST', `/api/agent/collaboration/${requestId}/cancel`, {}));
    },
    async escalate_to_human(args) {
      return JSON.stringify(await platformRequest('POST', '/api/agent/escalate', {
        audience: Array.isArray(args?.audience) ? args.audience.map(String) : [],
        message: String(args?.message ?? ''),
        ...(args?.urgency ? { urgency: String(args.urgency) } : {}),
      }));
    },
    async request_permission(args) {
      return JSON.stringify(await platformRequest('POST', '/api/agent/permission-requests', {
        capabilities: Array.isArray(args?.capabilities) ? args.capabilities.map(String) : [],
        ...(args?.projectIds !== undefined ? { projectIds: args.projectIds } : {}),
        audience: Array.isArray(args?.audience) ? args.audience.map(String) : [],
        reason: String(args?.reason ?? ''),
        ...(args?.urgency ? { urgency: String(args.urgency) } : {}),
      }));
    },
    async publish_task_branch() {
      return JSON.stringify(await platformRequest('POST', '/api/agent/git/publish', {}));
    },
    async import_task_branch(args) {
      return JSON.stringify(await platformRequest('POST', '/api/agent/git/import', { sourceTaskId: String(args?.source_task_id ?? '') }));
    },
    async refresh_upstream(args) {
      return JSON.stringify(await platformRequest('POST', '/api/agent/git/refresh-upstream', { branch: args?.branch ? String(args.branch) : undefined }));
    },
    async list_events(args) {
      return JSON.stringify(await platformRequest('GET', `/api/tasks/${encodeURIComponent(String(args?.task_id ?? ''))}/events?since=${Number(args?.since ?? 0)}`));
    },
    async list_github_actions_runs(args) {
      const query = new URLSearchParams();
      for (const [key, value] of [['repository', args?.repository], ['branch', args?.branch], ['event', args?.event],
        ['status', args?.status], ['workflow', args?.workflow], ['page', args?.page], ['perPage', args?.per_page]] as const) {
        if (value !== undefined && value !== null && String(value) !== '') query.set(key, String(value));
      }
      return JSON.stringify(await platformRequest('GET', `/api/agent/github/actions/runs?${query}`));
    },
    async list_github_actions_workflows(args) {
      const query = new URLSearchParams();
      for (const [key, value] of [['repository', args?.repository], ['page', args?.page], ['perPage', args?.per_page]])
        if (value !== undefined) query.set(String(key), String(value));
      return JSON.stringify(await platformRequest('GET', `/api/agent/github/actions/workflows?${query}`));
    },
    async inspect_github_actions_run(args) {
      const query = new URLSearchParams();
      for (const [key, value] of [['repository', args?.repository], ['view', args?.view], ['attempt', args?.attempt],
        ['jobId', args?.job_id], ['page', args?.page], ['perPage', args?.per_page],
        ['offsetLines', args?.offset_lines], ['tailLines', args?.tail_lines], ['maxChars', args?.max_chars]])
        if (value !== undefined) query.set(String(key), String(value));
      return JSON.stringify(await platformRequest('GET', `/api/agent/github/actions/runs/${Number(args?.run_id)}?${query}`));
    },
    async manage_github_actions_run(args) {
      return JSON.stringify(await platformRequest('POST', `/api/agent/github/actions/runs/${Number(args?.run_id)}`, {
        repository: args?.repository ? String(args.repository) : undefined, action: String(args?.action ?? ''),
      }));
    },
    async dispatch_github_actions_workflow(args) {
      return JSON.stringify(await platformRequest('POST', '/api/agent/github/actions/dispatch', {
        repository: args?.repository ? String(args.repository) : undefined,
        workflow: args?.workflow, ref: String(args?.ref ?? ''), inputs: args?.inputs,
      }));
    },
    async describe_platform() {
      return JSON.stringify(PLATFORM_API_CATALOG);
    },
    async platform_request(args) {
      const method = String(args?.method ?? 'GET').toUpperCase();
      const requestPath = String(args?.path ?? '');
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return 'error: invalid method';
      // One shared exclusion list with the MCP surface. This copy used to deny
      // only /api/login and /api/setup, so it permitted POST /api/signup (which
      // bootstraps an organization *administrator*) and every /api/auth/* Better
      // Auth route — an agent could mint itself a human login with no user:write.
      const rejected = platformRequestPathError(requestPath);
      if (rejected) return `error: ${rejected}`;
      return JSON.stringify(await platformRequest(method, requestPath, normalizeRequestBody(args?.body)));
    },
    async signal_completion(args) {
      await ctx.signalCompletion(args?.summary ? String(args.summary) : undefined);
      return 'completion recorded';
    },
    async open_pr() {
      await ctx.openPr();
      return 'pull request requested; finish this turn now';
    },
    async resolve_decision(args) {
      const t = parseTransition(args);
      if (!t) return 'invalid resolve decision — use action: resume | retryStage | gotoStage | parkUntil | escalate';
      await ctx.resolveDecision(t);
      return `resolution recorded: ${t.do}`;
    },
    async confirm_decision(args) {
      const action = String(args?.action ?? '');
      if (!['confirm', 'revise', 'reject'].includes(action)) return 'invalid confirm decision — use action: confirm | revise | reject';
      if (args?.otherAttempts !== undefined && !['keep', 'cancel'].includes(args.otherAttempts)) return 'otherAttempts must be keep or cancel';
      await ctx.confirmDecision({ otherAttempts: args?.otherAttempts, action: action as 'confirm' | 'revise' | 'reject', text: args?.text ? String(args.text) : undefined });
      return `confirm decision recorded: ${action}`;
    },
  };
  const capturedTrace = currentTiming();
  return Object.fromEntries(Object.entries(handlers).map(([name, handler]) => [name,
    async (args: any) => {
      const trace = await capturedTrace;
      const execute = () => timed(name === 'search_connection_tools' ? 'tool.discovery.managed' : 'tool.execution.platform',
        () => handler(args), { operation: name });
      return trace ? (await withTiming(trace, execute)) : execute();
    }]));
}
