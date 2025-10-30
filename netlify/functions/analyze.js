const { OpenAI } = require("openai");

exports.handler = async (event) => {
    // 只接受POST請求
    if (event.httpMethod !== 'POST') {
        return {
            statusCode: 405,
            body: JSON.stringify({ error: 'Method Not Allowed' })
        };
    }

    try {
        const { image, description } = JSON.parse(event.body);

        // 驗證輸入
        if (!image || !description) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: '缺少必要的參數' })
            };
        }

        // 初始化OpenAI客戶端
        const client = new OpenAI({
            apiKey: process.env.POE_API_KEY,
            baseURL: "https://api.poe.com/v1",
        });

        // 調用API
        const chat = await client.chat.completions.create({
            model: "iCircuit",
            messages: [{
                role: "user",
                content: [
                    {
                        type: 'text',
                        text: `請分析以下電路圖並給出專業評論。學生的說明：${description}`
                    },
                    {
                        type: 'image_url',
                        image_url: {
                            url: `data:image/jpeg;base64,${image}`
                        }
                    }
                ]
            }]
        });

        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                result: chat.choices[0].message.content
            })
        };

    } catch (error) {
        console.error('Function error:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({
                error: error.message || '伺服器錯誤'
            })
        };
    }
};
