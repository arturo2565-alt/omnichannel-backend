import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import axios from 'axios';
import { Conversation } from './entities/conversation.entity';

const ARRIVAL_ALARM_INTERVAL_MS = 2 * 60 * 1000;

const ARRIVAL_CALL_TWIML =
  '<Response><Say language="es-MX" voice="Polly.Mia-Neural">Alerta de AutoFix. Un cliente acaba de llegar y está esperando afuera del taller. Por favor, sal a recibirlo.</Say></Response>';

@Injectable()
export class TwilioService implements OnModuleDestroy {
  /** conversationId → setInterval handle */
  private readonly arrivalAlarmIntervals = new Map<
    string,
    ReturnType<typeof setInterval>
  >();

  constructor(
    @InjectRepository(Conversation)
    private readonly conversationRepository: Repository<Conversation>,
  ) {}

  onModuleDestroy(): void {
    for (const conversationId of this.arrivalAlarmIntervals.keys()) {
      this.stopArrivalAlarmLoop(conversationId);
    }
  }

  private getTwilioConfig(): {
    accountSid: string;
    authToken: string;
    fromNumber: string;
    receptionPhone: string;
  } | null {
    const accountSid = process.env.TWILIO_ACCOUNT_SID?.trim() ?? '';
    const authToken = process.env.TWILIO_AUTH_TOKEN?.trim() ?? '';
    const fromNumber = process.env.TWILIO_PHONE_NUMBER?.trim() ?? '';
    const receptionPhone = process.env.TALLER_RECEPTION_PHONE?.trim() ?? '';
    if (!accountSid || !authToken || !fromNumber || !receptionPhone) {
      return null;
    }
    return { accountSid, authToken, fromNumber, receptionPhone };
  }

  /** Llama al teléfono de recepción con TwiML inline (sin webhook URL). */
  async triggerArrivalCall(): Promise<{
    ok: boolean;
    callSid?: string;
    error?: string;
  }> {
    const cfg = this.getTwilioConfig();
    if (!cfg) {
      const msg =
        'Twilio no configurado (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER, TALLER_RECEPTION_PHONE).';
      console.warn('[TwilioService]', msg);
      return { ok: false, error: msg };
    }

    const url = `https://api.twilio.com/2010-04-01/Accounts/${cfg.accountSid}/Calls.json`;
    const body = new URLSearchParams({
      To: cfg.receptionPhone,
      From: cfg.fromNumber,
      Twiml: ARRIVAL_CALL_TWIML,
    });

    try {
      const res = await axios.post<{ sid?: string }>(url, body.toString(), {
        auth: {
          username: cfg.accountSid,
          password: cfg.authToken,
        },
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 30_000,
      });
      const callSid = res.data?.sid;
      console.log('[TwilioService] Llamada de llegada disparada', {
        callSid,
        to: cfg.receptionPhone,
      });
      return { ok: true, callSid };
    } catch (err) {
      const detail =
        axios.isAxiosError(err) ?
          String(err.response?.data ?? err.message)
        : err instanceof Error ?
          err.message
        : String(err);
      console.error('[TwilioService] triggerArrivalCall falló:', detail);
      return { ok: false, error: detail };
    }
  }

  /**
   * Dispara la primera llamada y arranca el loop cada 2 min mientras
   * `cliente_esperando_afuera` siga en true en BD.
   */
  async startArrivalAlarmLoop(conversationId: string): Promise<void> {
    await this.triggerArrivalCall();

    if (this.arrivalAlarmIntervals.has(conversationId)) {
      return;
    }

    const intervalId = setInterval(() => {
      void this.tickArrivalAlarm(conversationId);
    }, ARRIVAL_ALARM_INTERVAL_MS);

    this.arrivalAlarmIntervals.set(conversationId, intervalId);
    console.log('[TwilioService] Loop de alarma iniciado', { conversationId });
  }

  private async tickArrivalAlarm(conversationId: string): Promise<void> {
    const conv = await this.conversationRepository.findOne({
      where: { id: conversationId },
      select: ['id', 'clienteEsperandoAfuera'],
    });

    if (!conv?.clienteEsperandoAfuera) {
      this.stopArrivalAlarmLoop(conversationId);
      console.log('[TwilioService] Alarma detenida (cliente atendido)', {
        conversationId,
      });
      return;
    }

    await this.triggerArrivalCall();
  }

  stopArrivalAlarmLoop(conversationId: string): void {
    const handle = this.arrivalAlarmIntervals.get(conversationId);
    if (!handle) return;
    clearInterval(handle);
    this.arrivalAlarmIntervals.delete(conversationId);
  }
}
