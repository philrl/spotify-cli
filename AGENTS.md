# AGENTS.md

## Build/Lint/Test Commands

- Build: `bun build spotify.ts --compile --outfile dist/spotify-cli`
- Run: `bun run spotify.ts`
- No dedicated test framework; manual testing required
- No lint command configured; TypeScript strict mode handles most checks

## Code Style Guidelines

- **Language**: TypeScript with strict mode enabled
- **Libraries**: Use Bun build-in libraries first, then node build in libraries. DO NOT install packages from NPM.
- **Imports**: Group Node.js built-ins first, then external libraries
- **Naming**: camelCase for functions/variables, UPPER_SNAKE_CASE for constants
- **Types**: Use interfaces for object types, explicit return types
- **Async**: Use async/await, handle errors with try/catch
- **Formatting**: No semicolons, template literals for interpolation
- **Error Handling**: Log errors with descriptive messages, graceful degradation
- **CLI Output**: Use color functions for user feedback, consistent messaging

## Tool Usage

- When you need to search docs, use `context7` tools.
- If you are unsure how to do something, use `gh_grep` to search code examples from github.
