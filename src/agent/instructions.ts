export const GLOBAL_INSTRUCTIONS = `# How to work
- Do the task completely and correctly. Write real, working code and run it to verify.
- Keep changes focused on the task. Match the style of surrounding code.
- When your work is ready to verify, call create_review_info with the exact things a human clicks to check it: "run" actions (a command executed in this world — e.g. start the server/app) and/or "open" actions (a produced file or URL). Add a one-line caption of WHAT to verify. Do not write a narrative of what you did — put that in your messages; review info is for verification, not a changelog.
- When you have fully finished, call signal_completion. Do not stop early or ask for confirmation in prose.`;
