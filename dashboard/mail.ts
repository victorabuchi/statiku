// Email from Statiku to the people who use it: password resets and alerts about their sites. Sent through any SMTP
// service (Brevo, Postmark, Resend, Amazon SES…) named by SMTP_URL, such as smtps://user:password@smtp.example.com:465,
// from MAIL_FROM. Without SMTP_URL the message is written to the log instead, which is enough on a laptop.
import nodemailer from "nodemailer";

export type Mail = { to: string; subject: string; text: string; html?: string };
export type Mailer = (mail: Mail) => Promise<void>;

export function smtpMailer(url = process.env.SMTP_URL, from = process.env.MAIL_FROM ?? "Statiku <hello@statiku.com>"): Mailer {
  if (!url) {
    return async (mail) => console.log(`Email to ${mail.to} (SMTP_URL isn't set, so it's only logged): ${mail.subject}\n${mail.text}`);
  }
  const transport = nodemailer.createTransport(url);
  return async (mail) => {
    await transport.sendMail({ from, ...mail });
  };
}

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// A short message in Statiku's plain style: a heading, a few lines, and one button. The text version says the same.
export function letter(o: { heading: string; lines: string[]; button?: { label: string; url: string }; foot?: string }): { text: string; html: string } {
  const text = [o.heading, "", ...o.lines, ...(o.button ? ["", `${o.button.label}: ${o.button.url}`] : []), ...(o.foot ? ["", o.foot] : [])].join("\n");
  const html = `<!doctype html><html><body style="margin:0;padding:32px 16px;background:#f1f1f1;font:15px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#303030">
<div style="max-width:480px;margin:0 auto;background:#fff;border-radius:14px;padding:28px;border:1px solid #e3e3e3">
<div style="font-weight:700;font-size:16px;margin-bottom:18px">Statiku</div>
<h1 style="margin:0 0 12px;font-size:20px;line-height:1.3;color:#1a1a1a">${escape(o.heading)}</h1>
${o.lines.map((l) => `<p style="margin:0 0 12px">${escape(l)}</p>`).join("\n")}
${o.button ? `<p style="margin:20px 0 4px"><a href="${escape(o.button.url)}" style="display:inline-block;background:#1a1a1a;color:#fff;text-decoration:none;font-weight:600;padding:10px 18px;border-radius:9px">${escape(o.button.label)}</a></p>` : ""}
${o.foot ? `<p style="margin:20px 0 0;font-size:13px;color:#616161">${escape(o.foot)}</p>` : ""}
</div></body></html>`;
  return { text, html };
}
