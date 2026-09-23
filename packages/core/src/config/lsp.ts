export * as ConfigLSP from "./lsp"

import { Schema } from "effect"
import { NonNegativeInt, PositiveInt } from "../schema"

export const Disabled = Schema.Struct({
  disabled: Schema.Literal(true),
})

export class Server extends Schema.Class<Server>("ConfigV2.LSP.Server")({
  command: Schema.String.pipe(Schema.Array),
  extensions: Schema.String.pipe(Schema.Array, Schema.optional),
  disabled: Schema.Boolean.pipe(Schema.optional),
  env: Schema.Record(Schema.String, Schema.String).pipe(Schema.optional),
  initialization: Schema.Record(Schema.String, Schema.Unknown).pipe(Schema.optional),
}) {}

export const Entry = Schema.Union([Disabled, Server])
export const Info = Schema.Union([Schema.Boolean, Schema.Record(Schema.String, Entry)])

export class Limits extends Schema.Class<Limits>("ConfigV2.LSP.Limits")({
  idle_timeout: NonNegativeInt.pipe(Schema.optional).annotate({
    description:
      "Milliseconds a language server root may go unused before it is retired (default: 600000, 10 minutes). Set to 0 to disable idle eviction.",
  }),
  max_concurrent: PositiveInt.pipe(Schema.optional).annotate({
    description:
      "Maximum number of live language server clients per server id. When a new root would exceed this, the least-recently-used root for that server id is retired first (default: 4).",
  }),
}) {}
