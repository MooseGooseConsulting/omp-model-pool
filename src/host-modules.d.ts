// Types for the one host package the extension imports. OMP serves
// `@oh-my-pi/pi-ai` to extensions at runtime, so it is not a dependency; this
// declares only the shape `src/index.ts` checks before using it.
declare module "@oh-my-pi/pi-ai" {
  export const AssistantMessageEventStream: unknown;
  export const streamSimple: unknown;
}
