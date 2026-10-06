# Codex worker

This is a private Node 24 service with its own package lock and strict TypeScript configuration. Keep deployment independent of Next.js.

- Model: `gpt-6.1-sol`; reasoning: `medium`; authentication: personal ChatGPT/Codex account.
- Dynamic tools live in `pocket_drive`; configure `features.code_mode.direct_only_tool_namespaces` with that namespace.
- Dispatch only registered tools for the active thread. Every drive callback uses the originating run capability.
- Never inherit application secrets or API keys into Codex. Preserve explicit proxy/CA trust settings.
- Keep shell, code host, browser/computer, plugins and unexpected approvals disabled.
- `/status` verifies sign-in and reachability; it does not prove model entitlement or document-tool exposure.
- Run `npm ci`, `npm run build`, `npm test`, `npm run smoke` here. Native smoke uses local fixture responses and must never consume account inference usage.
- Include new runtime modules in Docker COPY and TypeScript checks. Preserve UID/GID 1001 and the `/state` mount.
