#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import nodemailer from "nodemailer";

const OPEN_METEO_BASE = "https://api.open-meteo.com/v1";
const USER_AGENT = "weather-india-mcp/1.0";

interface CityInfo {
  lat: number;
  lon: number;
  state: string;
}

const INDIA_METROS: Record<string, CityInfo> = {
  Mumbai:       { lat: 19.076,  lon: 72.8777, state: "Maharashtra" },
  Delhi:        { lat: 28.6139, lon: 77.209,  state: "Delhi" },
  Bengaluru:    { lat: 12.9716, lon: 77.5946, state: "Karnataka" },
  Hyderabad:    { lat: 17.385,  lon: 78.4867, state: "Telangana" },
  Chennai:      { lat: 13.0827, lon: 80.2707, state: "Tamil Nadu" },
  Kolkata:      { lat: 22.5726, lon: 88.3639, state: "West Bengal" },
  Ahmedabad:    { lat: 23.0225, lon: 72.5714, state: "Gujarat" },
  Pune:         { lat: 18.5204, lon: 73.8567, state: "Maharashtra" },
  Jaipur:       { lat: 26.9124, lon: 75.7873, state: "Rajasthan" },
  Lucknow:      { lat: 26.8467, lon: 80.9462, state: "Uttar Pradesh" },
  Chandigarh:   { lat: 30.7333, lon: 76.7794, state: "Chandigarh" },
  Bhopal:       { lat: 23.2599, lon: 77.4126, state: "Madhya Pradesh" },
  Thiruvananthapuram: { lat: 8.5241, lon: 76.9366, state: "Kerala" },
  Guwahati:     { lat: 26.1445, lon: 91.7362, state: "Assam" },
  Patna:        { lat: 25.6093, lon: 85.1376, state: "Bihar" },
};

const WMO_CODES: Record<number, string> = {
  0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
  45: "Fog", 48: "Depositing rime fog",
  51: "Light drizzle", 53: "Moderate drizzle", 55: "Dense drizzle",
  56: "Light freezing drizzle", 57: "Dense freezing drizzle",
  61: "Slight rain", 63: "Moderate rain", 65: "Heavy rain",
  66: "Light freezing rain", 67: "Heavy freezing rain",
  71: "Slight snowfall", 73: "Moderate snowfall", 75: "Heavy snowfall",
  77: "Snow grains",
  80: "Slight rain showers", 81: "Moderate rain showers", 82: "Violent rain showers",
  85: "Slight snow showers", 86: "Heavy snow showers",
  95: "Thunderstorm", 96: "Thunderstorm with slight hail", 99: "Thunderstorm with heavy hail",
};

function describeWeatherCode(code: number): string {
  return WMO_CODES[code] ?? `Unknown (code ${code})`;
}

interface SeverityCheck {
  severity: "extreme" | "severe" | "moderate" | null;
  reasons: string[];
}

function assessSeverity(current: any): SeverityCheck {
  const reasons: string[] = [];
  let severity: SeverityCheck["severity"] = null;

  const temp = current.temperature_2m as number;
  const wind = current.wind_speed_10m as number;
  const code = current.weather_code as number;
  const humidity = current.relative_humidity_2m as number;

  if (temp >= 45) { reasons.push(`Extreme heat: ${temp}°C`); severity = "extreme"; }
  else if (temp >= 42) { reasons.push(`Severe heat: ${temp}°C`); severity = severity ?? "severe"; }
  else if (temp >= 40) { reasons.push(`Heat warning: ${temp}°C`); severity = severity ?? "moderate"; }

  if (wind >= 90) { reasons.push(`Cyclonic winds: ${wind} km/h`); severity = "extreme"; }
  else if (wind >= 60) { reasons.push(`Very high winds: ${wind} km/h`); severity = severity ?? "severe"; }
  else if (wind >= 40) { reasons.push(`Strong winds: ${wind} km/h`); severity = severity ?? "moderate"; }

  if ([82, 86, 99].includes(code)) {
    reasons.push(`Violent weather: ${describeWeatherCode(code)}`);
    severity = "extreme";
  } else if ([65, 67, 75, 95, 96].includes(code)) {
    reasons.push(`Severe weather: ${describeWeatherCode(code)}`);
    severity = severity ?? "severe";
  } else if ([63, 55, 57, 73, 81, 85].includes(code)) {
    reasons.push(`Moderate weather warning: ${describeWeatherCode(code)}`);
    severity = severity ?? "moderate";
  }

  if (humidity >= 95 && temp >= 35) {
    reasons.push(`Dangerous heat index: ${temp}°C at ${humidity}% humidity`);
    severity = severity ?? "severe";
  }

  return { severity, reasons };
}

async function fetchJSON<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  } catch (err) {
    console.error("API request failed:", err);
    return null;
  }
}

function buildForecastUrl(lat: number, lon: number): string {
  const params = [
    `latitude=${lat}`, `longitude=${lon}`,
    "current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,wind_direction_10m",
    "daily=weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,apparent_temperature_min,precipitation_sum,wind_speed_10m_max,uv_index_max",
    "timezone=Asia/Kolkata",
    "forecast_days=5",
  ].join("&");
  return `${OPEN_METEO_BASE}/forecast?${params}`;
}

function formatCurrent(current: any, units: any): string {
  return [
    `🌡  Temperature: ${current.temperature_2m}${units.temperature_2m} (feels like ${current.apparent_temperature}${units.apparent_temperature})`,
    `💧 Humidity: ${current.relative_humidity_2m}${units.relative_humidity_2m}`,
    `💨 Wind: ${current.wind_speed_10m} ${units.wind_speed_10m} (direction: ${current.wind_direction_10m}°)`,
    `🌤  Condition: ${describeWeatherCode(current.weather_code)}`,
  ].join("\n");
}

function formatDaily(daily: any, units: any): string {
  const lines: string[] = [];
  for (let i = 0; i < daily.time.length; i++) {
    lines.push([
      `📅 ${daily.time[i]}`,
      `   High: ${daily.temperature_2m_max[i]}${units.temperature_2m_max} / Low: ${daily.temperature_2m_min[i]}${units.temperature_2m_min}`,
      `   Feels like: ${daily.apparent_temperature_max[i]}${units.apparent_temperature_max} / ${daily.apparent_temperature_min[i]}${units.apparent_temperature_min}`,
      `   Condition: ${describeWeatherCode(daily.weather_code[i])}`,
      `   Rain: ${daily.precipitation_sum[i]} ${units.precipitation_sum} | Wind: ${daily.wind_speed_10m_max[i]} ${units.wind_speed_10m_max} | UV: ${daily.uv_index_max[i]}`,
    ].join("\n"));
  }
  return lines.join("\n\n");
}

const server = new McpServer({ name: "weather-india", version: "2.0.0" });

// ── Tool 1: Forecast by lat/lon (works globally) ──

server.registerTool(
  "get_forecast",
  {
    description:
      "Get current weather and 5-day forecast for any location by latitude and longitude. Works globally.",
    inputSchema: {
      latitude:  z.number().min(-90).max(90).describe("Latitude of the location"),
      longitude: z.number().min(-180).max(180).describe("Longitude of the location"),
    },
  },
  async ({ latitude, longitude }) => {
    const data = await fetchJSON<any>(buildForecastUrl(latitude, longitude));
    if (!data) {
      return { content: [{ type: "text" as const, text: "Failed to fetch weather data. Please try again." }] };
    }

    const current = formatCurrent(data.current, data.current_units);
    const daily = formatDaily(data.daily, data.daily_units);
    const { severity, reasons } = assessSeverity(data.current);

    let alert = "";
    if (severity) {
      alert = `\n\n⚠️  WEATHER ALERT [${severity.toUpperCase()}]\n${reasons.map(r => `   • ${r}`).join("\n")}`;
    }

    const text = `── Current Weather (${latitude}, ${longitude}) ──\n${current}${alert}\n\n── 5-Day Forecast ──\n${daily}`;
    return { content: [{ type: "text" as const, text }] };
  }
);

// ── Tool 2: Forecast for an Indian metro city by name ──

server.registerTool(
  "get_india_city_forecast",
  {
    description:
      "Get current weather and 5-day forecast for a major Indian metro city. " +
      "Supported cities: " + Object.keys(INDIA_METROS).join(", "),
    inputSchema: {
      city: z
        .string()
        .describe("Name of the Indian metro city (e.g. Mumbai, Delhi, Bengaluru)"),
    },
  },
  async ({ city }) => {
    const key = Object.keys(INDIA_METROS).find(
      (k) => k.toLowerCase() === city.trim().toLowerCase()
    );
    if (!key) {
      return {
        content: [{
          type: "text" as const,
          text: `City "${city}" not found. Available cities: ${Object.keys(INDIA_METROS).join(", ")}`,
        }],
      };
    }

    const info = INDIA_METROS[key];
    const data = await fetchJSON<any>(buildForecastUrl(info.lat, info.lon));
    if (!data) {
      return { content: [{ type: "text" as const, text: `Failed to fetch weather for ${key}.` }] };
    }

    const current = formatCurrent(data.current, data.current_units);
    const daily = formatDaily(data.daily, data.daily_units);
    const { severity, reasons } = assessSeverity(data.current);

    let alert = "";
    if (severity) {
      alert = `\n\n⚠️  WEATHER ALERT [${severity.toUpperCase()}]\n${reasons.map(r => `   • ${r}`).join("\n")}`;
    }

    const text = `── ${key}, ${info.state} ──\n${current}${alert}\n\n── 5-Day Forecast ──\n${daily}`;
    return { content: [{ type: "text" as const, text }] };
  }
);

// ── Tool 3: Weather alerts across all Indian metros ──

server.registerTool(
  "get_india_weather_alerts",
  {
    description:
      "Scan all major Indian metro cities and return weather alerts for any city experiencing severe or dangerous conditions " +
      "(extreme heat, heavy rain, cyclonic winds, thunderstorms, dangerously high humidity, etc.).",
    inputSchema: {},
  },
  async () => {
    const results: string[] = [];

    const entries = Object.entries(INDIA_METROS);
    const fetches = entries.map(async ([city, info]) => {
      const data = await fetchJSON<any>(buildForecastUrl(info.lat, info.lon));
      if (!data) return;

      const { severity, reasons } = assessSeverity(data.current);
      if (severity) {
        const temp = data.current.temperature_2m;
        const condition = describeWeatherCode(data.current.weather_code);
        results.push(
          `🔴 ${city}, ${info.state}  [${severity.toUpperCase()}]\n` +
          `   Current: ${temp}°C, ${condition}\n` +
          reasons.map((r) => `   • ${r}`).join("\n")
        );
      }
    });

    await Promise.all(fetches);

    if (results.length === 0) {
      return {
        content: [{
          type: "text" as const,
          text: "✅ No severe weather alerts across Indian metro cities right now. All clear!",
        }],
      };
    }

    const text =
      `⚠️  ACTIVE WEATHER ALERTS — Indian Metro Cities\n` +
      `${"─".repeat(48)}\n\n` +
      results.join("\n\n");

    return { content: [{ type: "text" as const, text }] };
  }
);

// ── Email transporter (configured via env variables) ──

function createTransporter() {
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!user || !pass) return null;

  return nodemailer.createTransport({
    host: process.env.SMTP_HOST ?? "smtp.gmail.com",
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === "true",
    auth: { user, pass },
  });
}

function buildEmailHtml(subject: string, body: string): string {
  const rows = body
    .split("\n")
    .map((line) => {
      line = line.trim();
      if (!line) return "";
      if (line.startsWith("──") || line.startsWith("⚠️")) {
        return `<tr><td colspan="2" style="padding:12px 0 4px;font-weight:bold;font-size:15px;border-bottom:1px solid #e5e7eb;color:#1d4ed8">${line}</td></tr>`;
      }
      if (line.startsWith("📅")) {
        return `<tr><td colspan="2" style="padding:10px 0 2px;font-weight:600;color:#374151">${line}</td></tr>`;
      }
      if (line.startsWith("🔴")) {
        return `<tr><td colspan="2" style="padding:8px 0 2px;font-weight:600;color:#dc2626">${line}</td></tr>`;
      }
      if (line.startsWith("•") || line.startsWith("   •")) {
        return `<tr><td style="padding:2px 0 2px 16px;color:#7f1d1d">⚠ ${line.replace(/•\s*/, "")}</td></tr>`;
      }
      return `<tr><td style="padding:2px 0;color:#374151">${line}</td></tr>`;
    })
    .join("");

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:system-ui,sans-serif;background:#f9fafb;margin:0;padding:24px">
  <div style="max-width:600px;margin:0 auto;background:#fff;border-radius:12px;box-shadow:0 1px 4px rgba(0,0,0,.08);overflow:hidden">
    <div style="background:linear-gradient(135deg,#1d4ed8,#0ea5e9);padding:24px 28px">
      <h1 style="margin:0;color:#fff;font-size:22px">🌦 Weather India Report</h1>
      <p style="margin:6px 0 0;color:#bfdbfe;font-size:13px">Generated on ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST</p>
    </div>
    <div style="padding:24px 28px">
      <table style="width:100%;border-collapse:collapse;font-size:14px">${rows}</table>
    </div>
    <div style="padding:14px 28px;background:#f3f4f6;font-size:12px;color:#6b7280;border-top:1px solid #e5e7eb">
      Powered by Open-Meteo · Weather India MCP
    </div>
  </div>
</body>
</html>`;
}

// ── Tool 4: Share weather summary via email ──

server.registerTool(
  "share_weather_via_email",
  {
    description:
      "Fetch weather details for a city or coordinates and send a formatted summary email to a given address. " +
      "Requires SMTP_USER and SMTP_PASS environment variables to be set. " +
      "Optionally configure SMTP_HOST (default: smtp.gmail.com), SMTP_PORT (default: 587), SMTP_FROM.",
    inputSchema: {
      to: z.string().email().describe("Recipient email address"),
      city: z
        .string()
        .optional()
        .describe("Indian metro city name (e.g. Mumbai). Use this OR latitude+longitude."),
      latitude: z
        .number()
        .min(-90)
        .max(90)
        .optional()
        .describe("Latitude — used when city is not provided"),
      longitude: z
        .number()
        .min(-180)
        .max(180)
        .optional()
        .describe("Longitude — used when city is not provided"),
    },
  },
  async ({ to, city, latitude, longitude }) => {
    const transporter = createTransporter();
    if (!transporter) {
      return {
        content: [{
          type: "text" as const,
          text: "Email not configured. Please set SMTP_USER and SMTP_PASS environment variables in your MCP config.",
        }],
      };
    }

    let lat: number;
    let lon: number;
    let locationLabel: string;

    if (city) {
      const key = Object.keys(INDIA_METROS).find(
        (k) => k.toLowerCase() === city.trim().toLowerCase()
      );
      if (!key) {
        return {
          content: [{
            type: "text" as const,
            text: `City "${city}" not found. Available cities: ${Object.keys(INDIA_METROS).join(", ")}`,
          }],
        };
      }
      const info = INDIA_METROS[key];
      lat = info.lat;
      lon = info.lon;
      locationLabel = `${key}, ${info.state}`;
    } else if (latitude !== undefined && longitude !== undefined) {
      lat = latitude;
      lon = longitude;
      locationLabel = `${lat}, ${lon}`;
    } else {
      return {
        content: [{
          type: "text" as const,
          text: "Please provide either a city name or latitude and longitude.",
        }],
      };
    }

    const data = await fetchJSON<any>(buildForecastUrl(lat, lon));
    if (!data) {
      return { content: [{ type: "text" as const, text: "Failed to fetch weather data." }] };
    }

    const current = formatCurrent(data.current, data.current_units);
    const daily = formatDaily(data.daily, data.daily_units);
    const { severity, reasons } = assessSeverity(data.current);

    let alertSection = "";
    if (severity) {
      alertSection = `\n\n⚠️  WEATHER ALERT [${severity.toUpperCase()}]\n${reasons.map(r => `   • ${r}`).join("\n")}`;
    }

    const body = `── ${locationLabel} ──\n${current}${alertSection}\n\n── 5-Day Forecast ──\n${daily}`;
    const subject = `Weather Report: ${locationLabel}${severity ? ` ⚠️ ${severity.toUpperCase()} ALERT` : ""}`;

    try {
      await transporter.sendMail({
        from: process.env.SMTP_FROM ?? process.env.SMTP_USER,
        to,
        subject,
        text: body,
        html: buildEmailHtml(subject, body),
      });

      return {
        content: [{
          type: "text" as const,
          text: `✅ Weather summary for ${locationLabel} sent successfully to ${to}.`,
        }],
      };
    } catch (err: any) {
      return {
        content: [{
          type: "text" as const,
          text: `Failed to send email: ${err?.message ?? String(err)}`,
        }],
      };
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Weather India MCP server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
