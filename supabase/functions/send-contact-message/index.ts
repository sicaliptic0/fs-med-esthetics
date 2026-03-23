import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

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

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const resendApiKey = Deno.env.get("RESEND_API_KEY");
  const contactToEmail = Deno.env.get("CONTACT_TO_EMAIL");
  const fromEmail = Deno.env.get("FROM_EMAIL");

  if (!resendApiKey || !contactToEmail || !fromEmail) {
    return jsonResponse({ error: "Missing RESEND_API_KEY, CONTACT_TO_EMAIL or FROM_EMAIL" }, 500);
  }

  try {
    const payload = await req.json();
    const name = String(payload?.name || "").trim();
    const email = String(payload?.email || "").trim();
    const message = String(payload?.message || "").trim();
    const source = String(payload?.source || "website").trim();

    if (!name || !email || !message) {
      return jsonResponse({ error: "Missing required fields" }, 400);
    }

    const html = `
      <div style="font-family: Arial, sans-serif; line-height:1.5;">
        <h2>New Contact Message</h2>
        <p><strong>Name:</strong> ${name}</p>
        <p><strong>Email:</strong> ${email}</p>
        <p><strong>Source:</strong> ${source}</p>
        <hr />
        <p style="white-space:pre-wrap;">${message}</p>
      </div>
    `;

    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [contactToEmail],
        reply_to: email,
        subject: `Website Contact: ${name}`,
        html,
      }),
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

