import { z } from "zod";
import { CommandError } from "./protocol.ts";
import { parseJsonInput } from "./validate.ts";

// The shape Chrome serves at /json/protocol: the protocol this Chrome build implements, so help never
// lags behind the browser.
interface ProtocolProperty {
  name: string;
  type?: string;
  $ref?: string;
  items?: { type?: string; $ref?: string };
  optional?: boolean;
  description?: string;
  enum?: string[];
}

interface ProtocolMember {
  name: string;
  description?: string;
  experimental?: boolean;
  deprecated?: boolean;
  parameters?: ProtocolProperty[];
  returns?: ProtocolProperty[];
}

interface ProtocolDomain {
  domain: string;
  description?: string;
  experimental?: boolean;
  deprecated?: boolean;
  commands?: ProtocolMember[];
  events?: ProtocolMember[];
}

export interface ProtocolSchema {
  domains: ProtocolDomain[];
}

export function parseProtocolSchema(raw: string): ProtocolSchema {
  // Only the list is checked: the members' shape is Chrome's, and help prints whatever fields it finds.
  const { domains } = parseJsonInput(z.object({ domains: z.array(z.looseObject({ domain: z.string() })) }), raw, "the browser's /json/protocol");
  return { domains: domains as ProtocolDomain[] };
}

// No topic lists domains, `Page` lists its commands and events, `Page.navigate` describes one of them.
export function protocolHelp(schema: ProtocolSchema, topic: string | undefined): string[] {
  if (topic === undefined) {
    return schema.domains.map((domain) => `${domain.domain}${flags(domain)}  ${domain.commands?.length ?? 0} commands, ${domain.events?.length ?? 0} events`);
  }
  const [domainName, memberName, ...extra] = topic.split(".");
  const domain = schema.domains.find((candidate) => candidate.domain.toLowerCase() === domainName?.toLowerCase());
  if (domain === undefined || extra.length > 0) {
    throw new CommandError("bad_args", `this Chrome has no CDP domain ${domainName}`, "run `patchrome --profile debug cdp help` to list domains");
  }
  if (memberName === undefined) {
    return [
      `${domain.domain}${flags(domain)}`,
      ...(domain.description === undefined ? [] : [firstLine(domain.description)]),
      "",
      "commands",
      ...(domain.commands ?? []).map((command) => `  ${domain.domain}.${command.name}${flags(command)}${command.description === undefined ? "" : `  ${firstLine(command.description)}`}`),
      "",
      "events",
      ...(domain.events ?? []).map((event) => `  ${domain.domain}.${event.name}${flags(event)}${event.description === undefined ? "" : `  ${firstLine(event.description)}`}`),
    ];
  }
  const command = domain.commands?.find((candidate) => candidate.name === memberName);
  const event = domain.events?.find((candidate) => candidate.name === memberName);
  const member = command ?? event;
  if (member === undefined) {
    throw new CommandError("bad_args", `${domain.domain} has no command or event ${memberName}`, `run \`patchrome --profile debug cdp help ${domain.domain}\``);
  }
  const heading = `${command === undefined ? "event" : "command"} ${domain.domain}.${member.name}${flags(member)}`;
  return [
    heading,
    ...(member.description === undefined ? [] : [member.description]),
    ...propertyBlock(command === undefined ? "fields" : "params", member.parameters),
    ...propertyBlock("returns", member.returns),
  ];
}

function propertyBlock(title: string, properties: ProtocolProperty[] | undefined): string[] {
  if (properties === undefined || properties.length === 0) return [];
  return ["", title, ...properties.map((property) => {
    const kind = property.$ref ?? (property.type === "array" ? `${property.items?.$ref ?? property.items?.type ?? "unknown"}[]` : property.type ?? "unknown");
    const choices = property.enum === undefined ? "" : ` (${property.enum.join("|")})`;
    return `  ${property.name}${property.optional === true ? "?" : ""}: ${kind}${choices}${property.description === undefined ? "" : `  ${firstLine(property.description)}`}`;
  })];
}

function flags(item: { experimental?: boolean; deprecated?: boolean }): string {
  return `${item.experimental === true ? " [experimental]" : ""}${item.deprecated === true ? " [deprecated]" : ""}`;
}

function firstLine(text: string): string {
  return text.split("\n")[0] ?? text;
}
