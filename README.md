# Pi model prompts

Adds model-specific prompt sections using rules in `model-prompts.json` in Pi’s agent directory. Rules can apply everywhere or only to the main session. Model changes rebuild the section; invalid rules warn without preventing valid siblings from applying.

Add the checkout directory to Pi’s `packages`; Pi discovers `extensions/model-prompts.ts` by convention. Keep model rules and prompt files in your agent directory, not in this project.

Run `node tests/request.test.mjs /absolute/path/to/pi-coding-agent` to test the outgoing requests against localhost without model-provider calls.
