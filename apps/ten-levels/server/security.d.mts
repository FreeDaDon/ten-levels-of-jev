import type { IncomingMessage } from "node:http";

export declare const MAX_BODY_BYTES: number;
export declare const SECURITY_HEADERS: Record<string, string>;
export declare function allowedFor(port: number, extraOrigins?: string | string[]): { origins: Set<string>; hosts: Set<string> };
export declare function checkRequest(
  req: Pick<IncomingMessage, "method" | "headers">,
  port: number,
  opts?: { needsJson?: boolean },
): { status: number; error: string } | null;
export declare function readJsonBody(req: IncomingMessage, limit?: number): Promise<any>;
