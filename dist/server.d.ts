#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/server";
import { BrowserRuntime } from "./browser.js";
export declare function createServer(runtime?: BrowserRuntime): McpServer;
