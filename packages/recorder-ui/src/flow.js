// What Start does (board #16531 comment 108056): the first press shows the
// instructions; "Start now" begins the recording; once "Don't show
// instructions again" is ticked, Start begins the recording at once.
// Pure: returns the next state and the effects the view must run.

/**
 * @typedef {{view:'setup'|'instructions', skipInstructions:boolean}} FlowState
 * @typedef {{type:'start-pressed'} | {type:'start-now'} | {type:'set-skip', value:boolean}
 *   | {type:'show-instructions'} | {type:'back'}} FlowEvent
 * @typedef {{type:'start'} | {type:'save-skip', value:boolean}} FlowEffect
 */

/**
 * @param {FlowState} state
 * @param {FlowEvent} event
 * @param {{canStart:boolean}} context
 * @returns {{state:FlowState, effects:FlowEffect[]}}
 */
export function startFlow(state, event, context) {
  switch (event.type) {
    case 'start-pressed':
      if (!context.canStart) return { state, effects: [] };
      if (state.skipInstructions) return { state, effects: [{ type: 'start' }] };
      return { state: { ...state, view: 'instructions' }, effects: [] };
    case 'start-now':
      // Not ready any more (the microphone was unplugged while reading):
      // go back to the checks, which say what to do.
      if (!context.canStart) return { state: { ...state, view: 'setup' }, effects: [] };
      return { state: { ...state, view: 'setup' }, effects: [{ type: 'start' }] };
    case 'set-skip':
      // The tick is saved when it is made, so it holds even if the user
      // then closes the window instead of starting.
      if (event.value === state.skipInstructions) return { state, effects: [] };
      return { state: { ...state, skipInstructions: event.value }, effects: [{ type: 'save-skip', value: event.value }] };
    case 'show-instructions':
      return { state: { ...state, view: 'instructions' }, effects: [] };
    case 'back':
      return { state: { ...state, view: 'setup' }, effects: [] };
    default:
      return { state, effects: [] };
  }
}
