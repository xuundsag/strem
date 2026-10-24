// Test helper: normalise a builder payload into exactly what goes on the wire.
//
// discord.js builders sometimes leave explicit `undefined` values in toJSON()
// (ButtonBuilder sets emoji: undefined, for example). Those keys are dropped by
// JSON.stringify, so Discord never sees them, but assert.deepStrictEqual does
// see them. Comparing against the serialised form is both fairer and closer to
// what is actually sent.

/** Round trip a value through JSON so undefined keys disappear. */
export function wire(value) {
  return JSON.parse(JSON.stringify(value));
}
