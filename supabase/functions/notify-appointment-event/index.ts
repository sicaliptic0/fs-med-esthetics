import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
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

type EventType = "new_booking" | "appointment_status_update";

const statusLabelEs: Record<string, string> = {
  pending: "en espera",
  confirmed: "confirmada",
  cancelled: "cancelada",
  modified: "modificada",
};

function renderBilingualEmail(input: {
  titleEn: string;
  titleEs: string;
  bodyEn: string;
  bodyEs: string;
  details: string[];
}) {
  const detailsHtml = input.details.map((d) => `<li>${d}</li>`).join("");
  return `
    <div style="font-family: Arial, sans-serif; line-height:1.5; color:#222;">
      <h2 style="margin-bottom:6px;">${input.titleEn}</h2>
      <p style="margin-top:0; color:#666;">${input.titleEs}</p>
      <p>${input.bodyEn}</p>
      <p>${input.bodyEs}</p>
      <ul>${detailsHtml}</ul>
      <hr style="margin:20px 0; border:none; border-top:1px solid #eee;" />
      <p style="font-size:12px; color:#666;">FS Med-Esthetics LLC</p>
    </div>
  `;
}

async function sendEmail(resendApiKey: string, fromEmail: string, to: string[], subject: string, html: string) {
  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: fromEmail,
      to,
      subject,
      html,
    }),
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Resend error: ${txt}`);
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const resendApiKey = Deno.env.get("RESEND_API_KEY");
  const fromEmail = Deno.env.get("FROM_EMAIL");
  const staffEmail = Deno.env.get("BOOKING_ALERT_EMAIL");

  if (!supabaseUrl || !serviceRole || !resendApiKey || !fromEmail) {
    return jsonResponse({ error: "Missing required env vars" }, 500);
  }

  const adminClient = createClient(supabaseUrl, serviceRole);

  try {
    const body = await req.json();
    const eventType = String(body?.event_type || "") as EventType;
    const patientId = String(body?.patient_id || "");
    const patientName = String(body?.patient_name || "Patient");
    const appointmentDate = String(body?.appointment_date || "");
    const appointmentTime = String(body?.appointment_time || "");
    const status = String(body?.status || "pending").toLowerCase();
    const instructions = String(body?.instructions || "").trim();
    const treatments: string[] = Array.isArray(body?.treatments) ? body.treatments : [];

    if (!eventType || !patientId) return jsonResponse({ error: "Missing event_type or patient_id" }, 400);

    let patientEmail = "";
    if (eventType === "appointment_status_update") {
      const { data: authUser, error: authErr } = await adminClient.auth.admin.getUserById(patientId);
      if (authErr || !authUser?.user?.email) {
        return jsonResponse({ error: "Could not resolve patient email" }, 400);
      }
      patientEmail = authUser.user.email;
    }

    const detailLines = [
      `<strong>Patient:</strong> ${patientName}`,
      `<strong>Date:</strong> ${appointmentDate || "-"}`,
      `<strong>Time:</strong> ${appointmentTime || "-"}`,
      `<strong>Status:</strong> ${status}`,
      `<strong>Treatments:</strong> ${treatments.length ? treatments.join(", ") : "-"}`,
      instructions ? `<strong>Instructions:</strong> ${instructions}` : "<strong>Instructions:</strong> -",
    ];

    if (eventType === "new_booking") {
      if (!staffEmail) {
        return jsonResponse({ error: "BOOKING_ALERT_EMAIL is not configured" }, 500);
      }

      const htmlStaff = renderBilingualEmail({
        titleEn: "New patient booking request",
        titleEs: "Nueva solicitud de cita de paciente",
        bodyEn: "A new appointment request is pending review in admin dashboard.",
        bodyEs: "Hay una nueva solicitud de cita pendiente de revisión en el panel admin.",
        details: detailLines,
      });
      await sendEmail(resendApiKey, fromEmail, [staffEmail], "New Booking Request | FS Med-Esthetics", htmlStaff);
    }

    if (eventType === "appointment_status_update") {
      const html = renderBilingualEmail({
        titleEn: `Appointment ${status}`,
        titleEs: `Cita ${statusLabelEs[status] || status}`,
        bodyEn: "Your appointment status has been updated by our team.",
        bodyEs: "El estado de tu cita ha sido actualizado por nuestro equipo.",
        details: detailLines,
      });
      await sendEmail(resendApiKey, fromEmail, [patientEmail], `FS Med-Esthetics | Appointment ${status}`, html);
    }

    return jsonResponse({ ok: true });
  } catch (error) {
    return jsonResponse({ error: (error as Error).message }, 500);
  }
});

