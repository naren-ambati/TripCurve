// the Terraform readers (bolt B5).
export * from './model.js';
export {
  type IacReadResult,
  isOverrideName,
  readIac,
  terraformWaiverComments,
} from './read-iac.js';
