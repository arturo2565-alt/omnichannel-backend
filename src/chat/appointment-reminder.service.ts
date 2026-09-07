import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, MoreThanOrEqual, Repository } from 'typeorm';
import { AppointmentEntity } from './entities/appointment.entity';
import { Conversation } from './entities/conversation.entity';
import { LeadEventEntity } from './entities/lead-event.entity';
import { Message } from './entities/chat.entity';
import { OutgoingMessageProducer } from '../messaging-queue/outgoing-message.producer';
import { LeadEventsService } from './lead-events.service';
import { WORKSHOP_TIMEZONE } from './appointment-intent';
import {
  normalizeWhatsAppMessageBody,
  normalizeWhatsAppRecipientWaId,
} from './whatsapp-config';

const REMINDER_WINDOW_MS = 24 * 60 * 60 * 1000;
const REMINDER_STATUS = 'recordatorio_enviado';

export type ReminderSweepResult = {
  scanned: number;
  sent: number;
  skipped: number;
  failed: number;
};

@Injectable()
export class AppointmentReminderService {
  private readonly logger = new Logger(AppointmentReminderService.name);
  private running = false;

  constructor(
    @InjectRepository(AppointmentEntity)
    private readonly appointmentRepository: Repository<AppointmentEntity>,
    @InjectRepository(LeadEventEntity)
    private readonly leadEventRepository: Repository<LeadEventEntity>,
    @InjectRepository(Message)
    private readonly messageRepository: Repository<Message>,
    private readonly outgoingMessageProducer: OutgoingMessageProducer,
    private readonly leadEventsService: LeadEventsService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_9AM, {
    timeZone: WORKSHOP_TIMEZONE,
  })
  async handleDailyReminderCron(): Promise<void> {
    this.logger.log('cron 9:00 AM: barrido de recordatorios de cita');
    await this.sendUpcomingAppointmentReminders();
  }

  async sendUpcomingAppointmentReminders(): Promise<ReminderSweepResult> {
    const result: ReminderSweepResult = {
      scanned: 0,
      sent: 0,
      skipped: 0,
      failed: 0,
    };
    if (this.running) {
      this.logger.warn('barrido omitido: ya hay uno en curso');
      return result;
    }
    this.running = true;
    try {
      const now = new Date();
      const until = new Date(now.getTime() + REMINDER_WINDOW_MS);
      const appointments = await this.appointmentRepository.find({
        where: {
          status: 'confirmada',
          scheduledAt: Between(now, until),
        },
        relations: ['conversation'],
        order: { scheduledAt: 'ASC' },
      });
      result.scanned = appointments.length;

      for (const apt of appointments) {
        try {
          const sent = await this.processAppointment(apt);
          if (sent) result.sent += 1;
          else result.skipped += 1;
        } catch (err) {
          result.failed += 1;
          this.logger.error(
            `recordatorio falló appointment=${apt.id} conversation=${apt.conversationId}: ${String(err)}`,
          );
        }
      }

      this.logger.log(
        `barrido listo scanned=${result.scanned} sent=${result.sent} skipped=${result.skipped} failed=${result.failed}`,
      );
      return result;
    } finally {
      this.running = false;
    }
  }

  private async processAppointment(apt: AppointmentEntity): Promise<boolean> {
    const conversation = apt.conversation;
    const conversationId = String(
      apt.conversationId ?? conversation?.id ?? '',
    ).trim();
    if (!conversation || !conversationId) return false;

    if (await this.hasRecentReminder(conversationId)) {
      return false;
    }

    const built = await this.buildOutboundPayload(conversation, apt);
    if (!built) return false;

    await this.outgoingMessageProducer.enqueueOutboundMessage(
      String(conversation.tallerId ?? '').trim(),
      conversationId,
      built.channel,
      built.metaPayload,
    );

    await this.leadEventsService.logTransition(conversationId, REMINDER_STATUS, {
      appointmentId: apt.id,
      scheduledAt: apt.scheduledAt.toISOString(),
      channel: built.channel,
      via: built.via,
    });

    this.logger.log(
      `recordatorio encolado conversation=${conversationId} appointment=${apt.id} channel=${built.channel} via=${built.via}`,
    );
    return true;
  }

  private async hasRecentReminder(conversationId: string): Promise<boolean> {
    const since = new Date(Date.now() - REMINDER_WINDOW_MS);
    const count = await this.leadEventRepository.count({
      where: {
        conversationId,
        status: REMINDER_STATUS,
        createdAt: MoreThanOrEqual(since),
      },
    });
    return count > 0;
  }

  private async buildOutboundPayload(
    conversation: Conversation,
    apt: AppointmentEntity,
  ): Promise<{
    channel: 'whatsapp' | 'messenger';
    metaPayload: Record<string, unknown>;
    via: 'template' | 'text' | 'message_tag';
  } | null> {
    const clientName =
      String(apt.clientName || conversation.contactName || 'Cliente').trim() ||
      'Cliente';
    const whenLabel = this.formatAppointmentWhen(apt.scheduledAt);
    const text = this.buildReminderText(clientName, whenLabel);

    if (this.isWhatsApp(conversation.platform)) {
      const to = normalizeWhatsAppRecipientWaId(conversation.externalId);
      if (!to) return null;
      const sessionOpen = await this.hasOpenCustomerCareWindow(conversation.id);
      if (sessionOpen) {
        const body = normalizeWhatsAppMessageBody(text);
        if (!body) return null;
        return {
          channel: 'whatsapp',
          via: 'text',
          metaPayload: {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to,
            type: 'text',
            text: { body: body.slice(0, 4096) },
          },
        };
      }
      return {
        channel: 'whatsapp',
        via: 'template',
        metaPayload: this.buildWhatsAppTemplatePayload(to, clientName, whenLabel),
      };
    }

    if (this.isMessenger(conversation.platform)) {
      const psid = String(conversation.externalId ?? '').trim();
      if (!psid) return null;
      return {
        channel: 'messenger',
        via: 'message_tag',
        metaPayload: {
          recipient: { id: psid },
          messaging_type: 'MESSAGE_TAG',
          tag: 'CONFIRMED_EVENT_UPDATE',
          message: { text: text.slice(0, 2000) },
        },
      };
    }

    return null;
  }

  private buildWhatsAppTemplatePayload(
    to: string,
    clientName: string,
    whenLabel: string,
  ): Record<string, unknown> {
    const name =
      process.env.WHATSAPP_REMINDER_TEMPLATE?.trim() || 'recordatorio_cita';
    const lang =
      process.env.WHATSAPP_REMINDER_TEMPLATE_LANG?.trim() || 'es_MX';
    return {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'template',
      template: {
        name,
        language: { code: lang },
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: clientName.slice(0, 60) },
              { type: 'text', text: whenLabel.slice(0, 60) },
            ],
          },
        ],
      },
    };
  }

  private async hasOpenCustomerCareWindow(
    conversationId: string,
  ): Promise<boolean> {
    const since = new Date(Date.now() - REMINDER_WINDOW_MS);
    const lastInbound = await this.messageRepository.findOne({
      where: { conversationId, direction: 'inbound' },
      order: { createdAt: 'DESC' },
    });
    if (!lastInbound?.createdAt) return false;
    return lastInbound.createdAt.getTime() >= since.getTime();
  }

  private buildReminderText(clientName: string, whenLabel: string): string {
    return `Hola ${clientName}, te recordamos tu cita en el taller ${whenLabel}. ¡Te esperamos!`;
  }

  private formatAppointmentWhen(scheduledAt: Date): string {
    try {
      const fmt = new Intl.DateTimeFormat('es-MX', {
        timeZone: WORKSHOP_TIMEZONE,
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      });
      return `el ${fmt.format(scheduledAt)}`;
    } catch {
      return `el ${scheduledAt.toISOString()}`;
    }
  }

  private isWhatsApp(platform: string | null | undefined): boolean {
    return String(platform ?? '').toLowerCase().trim().includes('whatsapp');
  }

  private isMessenger(platform: string | null | undefined): boolean {
    const s = String(platform ?? '').toLowerCase().trim();
    return s.includes('facebook') || s.includes('messenger') || s === 'fb';
  }
}
