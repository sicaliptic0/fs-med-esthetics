import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function escapeHtml(value: string): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Same lightweight "Markdown-lite" convention used in admin.html / dashboard.html:
// a line starting with "- "/"* " joins a bullet list, a line starting with
// "1. " joins a numbered list, a blank line breaks whatever's open, anything
// else is plain paragraph text. Lists don't need a blank line before them —
// "Recommendations:" immediately followed by "- item" lines still renders as
// a heading paragraph plus a real list.
function renderRecommendationBodyHtml(raw: string): string {
  const lines = String(raw || "").split("\n");
  const html: string[] = [];
  let list: { type: "ul" | "ol"; items: string[] } | null = null;
  let para: string[] = [];

  const flushPara = () => {
    if (para.length) {
      html.push(`<p style="margin:8px 0;">${para.map(escapeHtml).join("<br>")}</p>`);
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      const tag = list.type;
      html.push(
        `<${tag} style="margin:8px 0; padding-left:20px;">${
          list.items.map((i) => `<li style="margin-bottom:4px;">${escapeHtml(i)}</li>`).join("")
        }</${tag}>`,
      );
      list = null;
    }
  };

  lines.forEach((rawLine) => {
    const line = rawLine.trim();
    if (!line) { flushPara(); flushList(); return; }
    const bullet = line.match(/^[-*]\s+(.*)$/);
    const numbered = line.match(/^\d+\.\s+(.*)$/);
    if (bullet) {
      flushPara();
      if (!list || list.type !== "ul") { flushList(); list = { type: "ul", items: [] }; }
      list.items.push(bullet[1]);
    } else if (numbered) {
      flushPara();
      if (!list || list.type !== "ol") { flushList(); list = { type: "ol", items: [] }; }
      list.items.push(numbered[1]);
    } else {
      flushList();
      para.push(line);
    }
  });
  flushPara();
  flushList();
  return html.join("");
}

function renderRecommendationsEmail(input: {
  patientName: string;
  recommendations: { title: string; body: string }[];
  contactEmail: string;
}) {
  const sections = input.recommendations.map((rec) => `
    <div style="margin-bottom:24px; padding-bottom:20px; border-bottom:1px solid #EDE1E7;">
      <h3 style="margin:0 0 8px; color:#B76E88; font-family: Georgia, serif; font-size:18px; font-style:italic;">${escapeHtml(rec.title)}</h3>
      <div style="font-size:14px; color:#333; line-height:1.6;">${renderRecommendationBodyHtml(rec.body)}</div>
    </div>
  `).join("");

  return `
    <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto; color: #333;">
      <div style="background: #2A2330; padding: 28px 32px; text-align: center;">
        <h1 style="margin:0; color:#B76E88; font-family: Georgia, serif; font-size:22px; letter-spacing:4px; text-transform:uppercase;">Piel Spa</h1>
      </div>
      <div style="background:#FBF0F3; padding: 16px 32px; text-align:center; border-bottom: 1px solid #EDE1E7;">
        <p style="margin:0; font-size:13px; text-transform:uppercase; letter-spacing:2px; color:#B76E88; font-weight:bold;">
          Recomendaciones de tu Proveedor &nbsp;·&nbsp; Recommendations from Your Provider
        </p>
      </div>
      <div style="background:#fff; padding: 32px;">
        <p style="font-size:16px; margin-top:0;">Hola <strong>${escapeHtml(input.patientName)}</strong>,</p>
        <p style="font-size:14px; color:#666;">Tu proveedor te ha enviado las siguientes recomendaciones. También puedes verlas en tu portal de paciente, en la sección "Mensajes".</p>
        ${sections}
      </div>
      <div style="background:#FBF0F3; padding:20px 32px; text-align:center; border-top:1px solid #EDE1E7;">
        <p style="margin:0; font-size:11px; color:#888; line-height:1.8;">
          Piel Spa LLC<br>
          <a href="mailto:${input.contactEmail}" style="color:#B76E88; text-decoration:none;">${input.contactEmail}</a>
        </p>
      </div>
    </div>
  `;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const resendApiKey = Deno.env.get("RESEND_API_KEY");
  const fromRaw = Deno.env.get("FROM_EMAIL") ?? "noreply@piel-spa.com";
  const contactEmail = "info@piel-spa.com";
  const fromEmail = `Piel Spa <${fromRaw}>`;

  if (!supabaseUrl || !serviceRole || !resendApiKey) {
    return jsonResponse({ error: "Missing required env vars" }, 500);
  }

  const adminClient = createClient(supabaseUrl, serviceRole);

  try {
    const body = await req.json();
    const patientId = String(body?.patient_id || "");
    const patientName = String(body?.patient_name || "Patient");
    const patientEmailFromBody = String(body?.patient_email || "").trim();
    const recommendations: { title: string; body: string }[] = Array.isArray(body?.recommendations)
      ? body.recommendations.filter((r: unknown) => r && typeof r === "object" && (r as { title?: unknown }).title)
      : [];

    if (!patientId || !recommendations.length) {
      return jsonResponse({ error: "Missing patient_id or recommendations" }, 400);
    }

    let patientEmail = patientEmailFromBody;
    if (!patientEmail) {
      const { data: authUser, error: authErr } = await adminClient.auth.admin.getUserById(patientId);
      if (!authErr && authUser?.user?.email) patientEmail = authUser.user.email;
    }
    if (!patientEmail) {
      return jsonResponse({ error: "Could not resolve patient email" }, 400);
    }

    const html = renderRecommendationsEmail({ patientName, recommendations, contactEmail });
    const subject = recommendations.length === 1
      ? `Recomendación: ${recommendations[0].title} | Piel Spa`
      : `Nuevas Recomendaciones de tu Proveedor | Piel Spa`;

    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: fromEmail, to: [patientEmail], subject, html }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      return jsonResponse({ error: `Email provider error: ${errText}` }, 500);
    }

    return jsonResponse({ ok: true });
  } catch (error) {
    return jsonResponse({ error: (error as Error).message }, 500);
  }
});
