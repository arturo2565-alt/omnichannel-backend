import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { UnrecoverableError, type Job } from 'bullmq';
import axios, { AxiosError } from 'axios';
import {
  buildWhatsAppMessagesUrl,
  getWhatsAppAccessToken,
  getWhatsAppPhoneNumberId,
} from '../chat/whatsapp-config';
import {
  OUTGOING_MESSAGES_QUEUE,
  type OutgoingMessageJobData,
} from './outgoing-message.constants';

const META_HTTP_TIMEOUT_MS = 20_000;
const MESSENGER_SEND_URL = 'https://graph.facebook.com/v21.0/me/messages';

@Processor(OUTGOING_MESSAGES_QUEUE)
export class OutgoingMessageWorker extends WorkerHost {
  private readonly logger = new Logger(OutgoingMessageWorker.name);

  async process(job: Job<OutgoingMessageJobData>): Promise<void> {
    const channel = String(job.data?.channel ?? '').trim().toLowerCase();
    const conversationId = String(job.data?.conversationId ?? '').trim();
    const payload = job.data?.metaPayload;
    const attempt = `${job.attemptsMade + 1}/${job.opts.attempts ?? '?'}`;

    this.logger.log(
      `process start job=${job.id} attempt=${attempt} channel=${channel} conversation=${conversationId}`,
    );

    if (!payload || typeof payload !== 'object') {
      throw new UnrecoverableError(
        `outgoing job=${job.id}: metaPayload vacío o inválido`,
      );
    }

    try {
      if (channel === 'whatsapp') {
        await this.postWhatsApp(payload);
      } else if (channel === 'messenger' || channel === 'facebook') {
        await this.postMessenger(payload);
      } else {
        throw new UnrecoverableError(
          `outgoing job=${job.id}: canal no soportado "${channel}"`,
        );
      }
    } catch (err) {
      if (err instanceof UnrecoverableError) throw err;
      throw this.toRetryableError(err, channel, conversationId, job.id);
    }

    this.logger.log(
      `process ok job=${job.id} channel=${channel} conversation=${conversationId}`,
    );
  }

  private async postWhatsApp(metaPayload: Record<string, unknown>): Promise<void> {
    const phoneNumberId = getWhatsAppPhoneNumberId();
    const token = getWhatsAppAccessToken();
    if (!phoneNumberId) {
      throw new UnrecoverableError(
        'sendWhatsApp: falta WHATSAPP_PHONE_NUMBER_ID en entorno',
      );
    }
    if (!token) {
      throw new UnrecoverableError(
        'sendWhatsApp: falta WHATSAPP_ACCESS_TOKEN en entorno',
      );
    }

    const url = buildWhatsAppMessagesUrl(phoneNumberId);
    const { status, data } = await axios.post(url, metaPayload, {
      timeout: META_HTTP_TIMEOUT_MS,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      validateStatus: () => true,
    });
    this.assertMetaOk(status, data, 'whatsapp');
  }

  private async postMessenger(metaPayload: Record<string, unknown>): Promise<void> {
    const token = process.env.FB_PAGE_ACCESS_TOKEN?.trim();
    if (!token) {
      throw new UnrecoverableError(
        'sendMessenger: falta FB_PAGE_ACCESS_TOKEN en entorno',
      );
    }

    const { status, data } = await axios.post(MESSENGER_SEND_URL, metaPayload, {
      timeout: META_HTTP_TIMEOUT_MS,
      params: { access_token: token },
      headers: { 'Content-Type': 'application/json' },
      validateStatus: () => true,
    });
    this.assertMetaOk(status, data, 'messenger');
  }

  private assertMetaOk(
    status: number,
    data: unknown,
    channel: string,
  ): void {
    const errObj =
      data && typeof data === 'object' && 'error' in data
        ? (data as { error: unknown }).error
        : undefined;
    if (status >= 400 || errObj) {
      const detail =
        errObj !== undefined
          ? JSON.stringify(errObj)
          : JSON.stringify(data ?? {});
      throw new Error(`Meta ${channel} HTTP ${status}: ${detail}`);
    }
  }

  private toRetryableError(
    err: unknown,
    channel: string,
    conversationId: string,
    jobId: string | undefined,
  ): Error {
    if (axios.isAxiosError(err)) {
      return new Error(this.formatAxiosError(err, channel, conversationId, jobId));
    }
    if (err instanceof Error) {
      return err;
    }
    return new Error(String(err));
  }

  private formatAxiosError(
    err: AxiosError,
    channel: string,
    conversationId: string,
    jobId: string | undefined,
  ): string {
    const status = err.response?.status;
    const code = err.code ?? '';
    const body =
      err.response?.data !== undefined
        ? JSON.stringify(err.response.data)
        : err.message;
    return `Meta ${channel} falló job=${jobId} conversation=${conversationId} status=${status ?? 'network'} code=${code}: ${body}`;
  }
}
