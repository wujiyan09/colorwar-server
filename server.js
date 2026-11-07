// 存储当前活跃的房间和连接 { roomCode: Set<WebSocket> }
const rooms = new Map();

export default {
  async fetch(request, env, ctx) {
    const upgradeHeader = request.headers.get('Upgrade');
    
    // 检查是否为 WebSocket 升级请求
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
      return new Response('ColorWar WebSocket Server is Running!', { status: 200 });
    }

    // 创建 WebSocketPair 对
    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);

    let currentRoom = null;

    // 接受连接
    server.accept();

    // 监听客户端消息
    server.addEventListener('message', event => {
      try {
        const data = JSON.parse(event.data);

        // 加入/创建房间
        if (data.action === 'joinRoom') {
          currentRoom = data.roomCode;
          if (!rooms.has(currentRoom)) {
            rooms.set(currentRoom, new Set());
          }
          rooms.get(currentRoom).add(server);
          return;
        }

        // 转发数据包给同房间其他玩家
        if (currentRoom && rooms.has(currentRoom)) {
          const clients = rooms.get(currentRoom);
          for (const targetSocket of clients) {
            if (targetSocket !== server) {
              try {
                targetSocket.send(event.data);
              } catch (e) {
                clients.delete(targetSocket);
              }
            }
          }
        }
      } catch (e) {
        console.error("解析消息失败:", e);
      }
    });

    // 连接断开清理
    const cleanup = () => {
      if (currentRoom && rooms.has(currentRoom)) {
        const clients = rooms.get(currentRoom);
        clients.delete(server);
        if (clients.size === 0) {
          rooms.delete(currentRoom);
        }
      }
    };

    server.addEventListener('close', cleanup);
    server.addEventListener('error', cleanup);

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }
};
