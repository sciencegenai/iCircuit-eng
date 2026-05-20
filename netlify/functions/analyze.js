const { OpenAI } = require("openai");

const RESPONSE_HEADERS = {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
};

function jsonResponse(statusCode, payload) {
    return {
        statusCode,
        headers: RESPONSE_HEADERS,
        body: JSON.stringify(payload)
    };
}

function safeJsonParse(value) {
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

function stripCodeFences(text) {
    if (typeof text !== "string") return "";
    return text
        .replace(/^```json\s*/i, "")
        .replace(/^```\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim();
}

function normalizeImageInput(image) {
    if (typeof image !== "string" || !image.trim()) return "";

    const trimmed = image.trim();

    // 如果前端已經傳完整 data URL，就直接使用
    if (trimmed.startsWith("data:image/")) {
        return trimmed;
    }

    // 否則預設當作 jpeg base64
    return `data:image/jpeg;base64,${trimmed}`;
}

function extractAssistantText(content) {
    if (!content) return "";

    if (typeof content === "string") {
        return content.trim();
    }

    if (Array.isArray(content)) {
        const text = content
            .map((part) => {
                if (!part) return "";

                if (typeof part === "string") return part;

                if (part.type === "text" && typeof part.text === "string") {
                    return part.text;
                }

                if (typeof part.text === "string") {
                    return part.text;
                }

                return "";
            })
            .filter(Boolean)
            .join("\n")
            .trim();

        return text;
    }

    if (typeof content === "object") {
        return JSON.stringify(content);
    }

    return "";
}

function tryParseStructuredResult(rawText) {
    if (!rawText) return null;

    if (typeof rawText === "object") {
        return rawText;
    }

    const cleaned = stripCodeFences(String(rawText).trim());

    // 先直接 parse
    let parsed = safeJsonParse(cleaned);
    if (parsed && typeof parsed === "object") {
        return parsed;
    }

    // 如果前後有多餘文字，嘗試只取最外層 JSON 區塊
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");

    if (start !== -1 && end !== -1 && end > start) {
        const maybeJson = cleaned.slice(start, end + 1);
        parsed = safeJsonParse(maybeJson);
        if (parsed && typeof parsed === "object") {
            return parsed;
        }
    }

    return null;
}

function uniqueNonEmptyStrings(list) {
    const seen = new Set();
    const result = [];

    for (const item of list) {
        if (typeof item !== "string") continue;
        const cleaned = item.trim();
        if (!cleaned) continue;
        if (seen.has(cleaned)) continue;
        seen.add(cleaned);
        result.push(cleaned);
    }

    return result;
}

function buildHumanFeedback(parsedResult, rawText) {
    // 如果不是 JSON，就直接回原始文字
    if (!parsedResult || typeof parsedResult !== "object") {
        if (typeof rawText === "string" && rawText.trim()) {
            return rawText.trim();
        }
        return "I could not generate readable feedback for this circuit.";
    }

    const description =
        typeof parsedResult.description === "string"
            ? parsedResult.description.trim()
            : "";

    const items = Array.isArray(parsedResult.items) ? parsedResult.items : [];

    const goodNotes = [];
    const improveNotes = [];

    for (const item of items) {
        if (!item || typeof item !== "object") continue;

        const note =
            typeof item.notes === "string"
                ? item.notes.trim()
                : "";

        if (!note) continue;

        if (item.ok === true) {
            goodNotes.push(note);
        } else if (item.ok === false) {
            improveNotes.push(note);
        }
    }

    const positives = uniqueNonEmptyStrings(goodNotes).slice(0, 4);
    const improvements = uniqueNonEmptyStrings(improveNotes).slice(0, 4);

    const parts = [];

    if (description) {
        parts.push(description);
    }

    if (positives.length > 0) {
        parts.push(`What you did well:\n- ${positives.join("\n- ")}`);
    }

    if (improvements.length > 0) {
        parts.push(`Things to improve:\n- ${improvements.join("\n- ")}`);
    } else {
        parts.push("Overall, this circuit looks correct. Nice work!");
    }

    return parts.join("\n\n").trim();
}

exports.handler = async (event) => {
    // 處理 CORS preflight
    if (event.httpMethod === "OPTIONS") {
        return {
            statusCode: 204,
            headers: RESPONSE_HEADERS,
            body: ""
        };
    }

    // 只接受 POST
    if (event.httpMethod !== "POST") {
        return jsonResponse(405, { error: "Method Not Allowed" });
    }

    // 檢查 API Key
    if (!process.env.POE_API_KEY) {
        return jsonResponse(500, { error: "伺服器未設定 POE_API_KEY" });
    }

    let body;

    try {
        body = JSON.parse(event.body || "{}");
    } catch {
        return jsonResponse(400, { error: "Request body 不是有效的 JSON" });
    }

    const image = body.image;
    const description =
        typeof body.description === "string" ? body.description.trim() : "";

    // 驗證輸入
    if (!image || !description) {
        return jsonResponse(400, { error: "缺少必要的參數" });
    }

    try {
        // 初始化 OpenAI client（目前仍指向 Poe 相容端點）
        const client = new OpenAI({
            apiKey: process.env.POE_API_KEY,
            baseURL: "https://api.poe.com/v1"
        });

        // 呼叫 API
        const chat = await client.chat.completions.create({
            model: "iCircuit",
            messages: [
                {
                    role: "user",
                    content: [
                        {
                            type: "text",
                            text: [
                                "Please analyze the following circuit diagram and the student's explanation.",
                                "Write the feedback in English.",
                                "If your system is configured to return structured JSON, that is acceptable.",
                                `Student's explanation: ${description}`
                            ].join("\n")
                        },
                        {
                            type: "image_url",
                            image_url: {
                                url: normalizeImageInput(image)
                            }
                        }
                    ]
                }
            ]
        });

        const messageContent = chat?.choices?.[0]?.message?.content;
        const rawResult = extractAssistantText(messageContent);
        const parsedResult = tryParseStructuredResult(rawResult);
        const humanFeedback = buildHumanFeedback(parsedResult, rawResult);

        // 重點：
        // result 直接回傳人類可讀內容，這樣你前端如果本來顯示 result，就不會再只看到 JSON
        return jsonResponse(200, {
            result: humanFeedback,
            human_feedback: humanFeedback,
            structured_result: parsedResult,
            raw_result: rawResult
        });
    } catch (error) {
        console.error("Function error:", error?.response?.data || error);

        return jsonResponse(500, {
            error: error?.message || "伺服器錯誤"
        });
    }
};
