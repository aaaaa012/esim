import { Injectable, ServiceUnavailableException } from "@nestjs/common";

@Injectable()
export class WhatsappChannel {
  async send(input: { to: string; text: string }) {
    if (process.env.NOTIFICATION_MODE !== "live")
      return {
        providerMessageId: `whatsapp-sim-${Date.now()}`,
        simulated: true,
      };
    const {
      WHATSAPP_API_URL: url,
      WHATSAPP_ACCESS_TOKEN: token,
      WHATSAPP_PHONE_NUMBER_ID: phoneId,
    } = process.env;
    if (!url || !token || !phoneId) {
      if (process.env.NODE_ENV !== "production")
        return {
          providerMessageId: `whatsapp-sim-${Date.now()}`,
          simulated: true,
        };
      throw new ServiceUnavailableException(
        "WhatsApp delivery is not configured",
      );
    }
    const response = await fetch(
      `${url.replace(/\/$/, "")}/${phoneId}/messages`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: input.to,
          type: "text",
          text: { body: input.text },
        }),
      },
    );
    if (!response.ok)
      throw new ServiceUnavailableException("WhatsApp message delivery failed");
    const result = (await response.json()) as { messages?: { id: string }[] };
    return {
      providerMessageId: result.messages?.[0]?.id ?? "accepted",
      simulated: false,
    };
  }
}
