import type { FastifyInstance } from 'fastify';
import { ACTIVITY_PAGE_SIZE, type ActivityService } from '../activity/service.js';

export function registerActivityRoutes(app: FastifyInstance, activity: ActivityService): void {
    // Activity history (checks, notifications, errors) — newest first
    app.get<{ Querystring: { limit?: string } }>('/api/activity', async request => {
        const parsed = Number.parseInt(request.query?.limit || '', 10);
        const limit = Number.isFinite(parsed) && parsed > 0 && parsed <= ACTIVITY_PAGE_SIZE ? parsed : ACTIVITY_PAGE_SIZE;
        return { logs: activity.list(limit) };
    });
}
