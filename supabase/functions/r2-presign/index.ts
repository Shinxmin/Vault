// Vaulty가 브라우저에서 R2 시크릿 키를 직접 다루지 않도록 하는 프록시 함수.
// R2 접근 키는 Supabase 프로젝트의 서버 전용 시크릿으로만 보관되며 이 함수 밖으로 노출되지 않는다.
// 업로드/다운로드는 이 함수가 발급한 presigned URL로 브라우저가 R2에 직접 PUT/GET하고,
// 삭제만 이 함수가 자신의 자격증명으로 직접 수행한다(presigned DELETE보다 왕복이 적다).
import { AwsClient } from "https://esm.sh/aws4fetch@1.0.20";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const accountId = Deno.env.get("R2_ACCOUNT_ID");
  const accessKeyId = Deno.env.get("R2_ACCESS_KEY_ID");
  const secretAccessKey = Deno.env.get("R2_SECRET_ACCESS_KEY");
  const bucket = Deno.env.get("R2_BUCKET_NAME");

  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) {
    console.error("R2 환경변수(R2_ACCOUNT_ID/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY/R2_BUCKET_NAME)가 설정되지 않음");
    return json({ error: "R2가 아직 설정되지 않았습니다" }, 500);
  }

  const client = new AwsClient({
    accessKeyId,
    secretAccessKey,
    service: "s3",
    region: "auto",
  });
  const endpoint = `https://${accountId}.r2.cloudflarestorage.com`;
  const objectUrl = (key: string) => `${endpoint}/${bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;

  const presign = async (key: string, method: "PUT" | "GET", contentType?: string, expiresIn = 3600) => {
    const url = new URL(objectUrl(key));
    url.searchParams.set("X-Amz-Expires", String(expiresIn));
    const headers: Record<string, string> = {};
    if (contentType && method === "PUT") headers["content-type"] = contentType;
    const signed = await client.sign(new Request(url, { method, headers }), {
      aws: { signQuery: true },
    });
    return signed.url;
  };

  let body: {
    action?: "put" | "get" | "get-batch" | "delete";
    key?: string;
    keys?: string[];
    contentType?: string;
  } = {};
  try {
    body = await req.json();
  } catch (_e) {
    return json({ error: "잘못된 요청 본문" }, 400);
  }

  try {
    if (body.action === "put" && body.key) {
      const url = await presign(body.key, "PUT", body.contentType);
      return json({ url });
    }
    if (body.action === "get" && body.key) {
      const url = await presign(body.key, "GET", undefined, 60 * 60 * 24);
      return json({ url });
    }
    if (body.action === "get-batch" && Array.isArray(body.keys)) {
      const entries = await Promise.all(
        body.keys.map(async (key) => [key, await presign(key, "GET", undefined, 60 * 60 * 24)] as const)
      );
      return json({ urls: Object.fromEntries(entries) });
    }
    if (body.action === "delete" && body.key) {
      const resp = await client.fetch(objectUrl(body.key), { method: "DELETE" });
      return json({ success: resp.ok || resp.status === 404 });
    }
    return json({ error: "지원하지 않는 action" }, 400);
  } catch (e) {
    console.error("r2-presign 처리 중 오류:", e);
    return json({ error: "처리 중 오류가 발생했습니다" }, 500);
  }
});
