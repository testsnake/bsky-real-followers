import 'dotenv/config';

import { AtpAgent, RichText } from '@atproto/api';

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 min

async function run() {
    const host = process.env.ACCOUNT_HOST || 'https://bsky.social';
    const agent = new AtpAgent({ service: host });

    await agent.login({
        identifier: process.env.ACCOUNT_USERNAME || '',
        password: process.env.ACCOUNT_PASSWORD || '',
    });

    console.log(`Logged in. Polling notifications every ${POLL_INTERVAL_MS / 1000}s...`);

    const poll = async () => {
        try {
            console.log(`[${new Date().toISOString()}] Checking notifications...`);
            await readFromNotifications(agent);
        } catch (err) {
            console.error('Error during notification check:', err);
        } finally {
            setTimeout(poll, POLL_INTERVAL_MS);
        }
    };

    await poll();
}

async function readFromNotifications(agent: AtpAgent) {
    const profile = await agent.getProfile({ actor: agent.did! });
    const handle = profile.data.handle;

    let cursor: string | undefined = undefined;
    do {
        const res = await agent.listNotifications({
            limit: 100,
            cursor,
            reasons: ['mention', 'reply'],
        });
        cursor = res.data.cursor;

        const unread = res.data.notifications.filter((n) => !n.isRead);

        for (const notif of unread) {
            const record = notif.record as Record<string, any>;
            const text: string = record?.text ?? '';

            if (notif.reason === 'reply') {
                const mentioned =
                    text.toLowerCase().includes(`@${handle.toLowerCase()}`) ||
                    (record?.facets ?? []).some((facet: any) =>
                        facet.features?.some(
                            (f: any) =>
                                f.$type === 'app.bsky.richtext.facet#mention' &&
                                f.did === agent.did
                        )
                    );

                if (!mentioned) continue;
            }

            await replyToNotification(agent, notif);
        }

        await agent.updateSeenNotifications(new Date().toISOString());

        if (unread.length === 0) break;
    } while (cursor);
}

async function replyToNotification(agent: AtpAgent, notification: any) {
    const record = notification.record as Record<string, any>;

    const root: { uri: string; cid: string } = record?.reply?.root ?? {
        uri: notification.uri,
        cid: notification.cid,
    };

    const parent: { uri: string; cid: string } = {
        uri: notification.uri,
        cid: notification.cid,
    };

    // Check facets for any @mention that isn't the bot itself
    const facets: any[] = record?.facets ?? [];
    const mentionedDid = facets
        .flatMap((f: any) => f.features ?? [])
        .find(
            (f: any) =>
                f.$type === 'app.bsky.richtext.facet#mention' &&
                f.did !== agent.did
        )?.did;

    // If another user was mentioned, count them; otherwise count the post author
    const targetDid = mentionedDid ?? notification.author.did;
    const targetProfile = await agent.getProfile({ actor: targetDid });
    const targetHandle = targetProfile.data.handle;

    const followers = await countFollowers(agent, targetDid);

    const replyText = `@${notification.author.handle} @${targetHandle} has ${followers} followers that have not been blocked/suspended/deleted.`;

    const rt = new RichText({ text: replyText });
    await rt.detectFacets(agent);

    await agent.post({
        text: rt.text,
        facets: rt.facets,
        reply: { root, parent },
        createdAt: new Date().toISOString(),
    });

    console.log(`Replied to ${notification.author.handle} (${notification.reason}): ${notification.uri}`);
}

async function countFollowers(agent: AtpAgent, did: string): Promise<number> {
    let count = 0;
    let cursor: string | undefined = undefined;
    do {
        const res = await agent.getFollowers({ actor: did, limit: 100, cursor });
        count += res.data.followers.length;
        cursor = res.data.cursor;
    } while (cursor);
    return count;
}

run().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
});