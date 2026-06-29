/** Programmatic access to the CLI command handlers (the `mystars-faas` bin wires these to commander). */
export {
  cmdPricing,
  cmdProducts,
  cmdCurrencies,
  cmdRecipientCheck,
  cmdOrdersCreate,
  cmdOrdersGet,
  cmdOrdersList,
  cmdOrdersCancel,
  cmdWatch,
  cmdWebhookVerify,
  type CliIO,
} from "./commands.js";
