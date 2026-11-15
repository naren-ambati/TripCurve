// The shared vocabulary. Every other unit imports from here.
export * from './finding.js';
export * from './limits.js';
export * from './provenance.js';
export * from './results.js';
export {
  compareInputText,
  type Destination,
  type InputText,
  inputText,
  inputTextEquals,
  isInputText,
  type RenderOptions,
  SafeText,
  TERMINAL_WIDTH,
} from './safe-text.js';
export * from './vocab.js';
