// custom.d.ts or in your TypeScript file
declare module '@stoprocent/noble/with-custom-binding' {
  import * as noble from '@stoprocent/noble';

  // Optionally, extend or modify types here
  export default noble;
}

// Minimal `xstate` typing stub needed for `@xstate/store`'s optional `fromStore()` helper typings.
// We do not depend on the full `xstate` package in this repo.
declare module 'xstate' {
  /* eslint-disable @typescript-eslint/no-unused-vars */
  export type ActorLogic<
    TSnapshot = unknown,
    TEvent = { type: string },
    TInput = unknown,
    _TSystem = unknown,
    TEmitted = { type: string },
  > = unknown;
  /* eslint-enable @typescript-eslint/no-unused-vars */
}
