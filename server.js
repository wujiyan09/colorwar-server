const WebSocket = require('ws');
const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

// 房间状态映射：{ roomCode: [ws1, ws2, ...] }
const rooms = {};

console.log(`[ColorWar] WebSocket 服务器初始化，监听端口: ${PORT}`);

wss.on('connection', (ws) => {
    let currentRoom = null;

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);

            // 1. 处理玩家加入/创建房间请求
            if (data.action === 'joinRoom') {
                currentRoom = data.roomCode;
                if (!rooms[currentRoom]) {
                    rooms[currentRoom] = [];
                }
                if (!rooms[currentRoom].includes(ws)) {
                    rooms[currentRoom].push(ws);
                }
                console.log(`[ColorWar] 玩家加入房间: ${currentRoom}，当前房间人数: ${rooms[currentRoom].length}`);
                return;
            }

            // 2. 将收到的 P2PPacket 数据原样广播给该房间内的其他所有在线玩家
            if (currentRoom && rooms[currentRoom]) {
                rooms[currentRoom].forEach((client) => {
                    if (client !== ws && client.readyState === WebSocket.OPEN) {
                        client.send(message.toString());
                    }
                });
            }
        } catch (e) {
            console.error('[ColorWar] 消息解析错误:', e);
        }
    });

    ws.on('close', () => {
        if (currentRoom && rooms[currentRoom]) {
            rooms[currentRoom] = rooms[currentRoom].filter(client => client !== ws);
            console.log(`[ColorWar] 玩家离开房间: ${currentRoom}，剩余人数: ${rooms[currentRoom].length}`);
            if (rooms[currentRoom].length === 0) {
                delete rooms[currentRoom];
                console.log(`[ColorWar] 房间 ${currentRoom} 已销毁`);
            }
        }
    });
});
