/**
 * Runs Backstage and streams its progress as it happens, one JSON event per
 * line (NDJSON): the plan, each step starting, each model call starting and
 * ending, each step finishing, then "done". The finished run is saved exactly
 * as before, so the page shows the full result after the stream ends.
 */
import { runAgent, type AgentEvent } from "@/lib/agent/agent";
import { saveRun } from "@/lib/agent/runStore";
import { isProfile } from "@/lib/agent/routing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let body: { email?: string; from?: string; firstName?: string; profile?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Expected a JSON body" }, { status: 400 });
  }
  const { email = "", from = "", firstName = "", profile = "" } = body;
  if (!isProfile(profile)) return Response.json({ error: "Unknown profile" }, { status: 400 });
  if (!email.trim()) return Response.json({ error: "The email is empty" }, { status: 400 });

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const send = (e: AgentEvent) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(JSON.stringify(e) + "\n"));
        } catch {
          open = false; // the viewer left; the run still finishes and is saved
        }
      };
      try {
        const run = await runAgent(id, email, from, firstName, profile, send);
        await saveRun(run);
        send({ type: "done", runId: run.id, totals: run.totals, at: Date.now() });
      } catch (err) {
        send({ type: "error", message: (err as Error).message, at: Date.now() });
      } finally {
        if (open) controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      // no-transform keeps compression from buffering the stream
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
