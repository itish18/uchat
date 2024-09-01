import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import bodyParser from "body-parser";

import { PrismaClient } from "@prisma/client";

import { createServer } from "node:http";
import { Server } from "socket.io";
import { authenticateToken } from "./middleware/auth-token.js";
import cors from "cors";

const rooms = {};

const app = express();
app.use(cors());
const prisma = new PrismaClient();
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
  },
});

app.use(bodyParser.json());

io.on("connection", (socket) => {
  console.log(socket.id, "Connected");

  socket.on("join-room", (roomId, userId, receiverId) => {
    console.log(roomId, userId, receiverId);
    if (!rooms[roomId]) {
      rooms[roomId] = [];
    }
    rooms[roomId].push(userId);
    socket.join(roomId);
    if (!rooms[roomId]?.includes(receiverId)) {
      io.emit(`incomingCall:${receiverId}`, {
        roomId,
        userId,
      });
    }
    console.log(rooms);
    socket.to(roomId).emit("user-connected", userId);
  });

  socket.on("offer", (roomId, offer) => {
    socket.to(roomId).emit("offer", offer);
  });

  socket.on("answer", (roomId, answer) => {
    socket.to(roomId).emit("answer", answer);
  });

  socket.on("ice-candidate", (roomId, candidate) => {
    socket.to(roomId).emit("ice-candidate", candidate);
  });

  socket.on("message", async ({ userId, receiverId, content }) => {
    try {
      let conversation = await prisma.conversation.findFirst({
        where: {
          OR: [
            {
              userOneId: userId,
              userTwoId: receiverId,
            },
            {
              userOneId: receiverId,
              userTwoId: userId,
            },
          ],
        },
      });

      if (!conversation) {
        conversation = await prisma.conversation.create({
          data: {
            userOneId: userId,
            userTwoId: receiverId,
            lastMessage: content,
            unreadMessageCountUser1: userId === receiverId ? 0 : 1,
            unreadMessageCountUser2: userId === receiverId ? 1 : 0,
            lastMessageAt: new Date(),
          },
        });
      } else {
        const updateData = {
          lastMessage: content,
          lastMessageAt: new Date(),
        };

        if (conversation.userOneId === receiverId) {
          updateData.unreadMessageCountUser1 =
            conversation.unreadMessageCountUser1 + 1;
        } else if (conversation.userTwoId === receiverId) {
          updateData.unreadMessageCountUser2 =
            conversation.unreadMessageCountUser2 + 1;
        }

        conversation = await prisma.conversation.update({
          where: {
            id: conversation.id,
          },
          data: updateData,
        });
      }

      const message = await prisma.message.create({
        data: {
          content,
          senderId: userId,
          receiverId,
          conversationId: conversation.id,
        },
      });

      const messageDate = message.createdAt.toISOString().split("T")[0];

      io.emit(`message:${receiverId}:new`, {
        content,
        senderId: userId,
        receiverId,
        conversationId: conversation.id,
        createdAt: message.createdAt,
        date: messageDate,
        id: message?.id,
      });

      io.emit(`conversation:${receiverId}:new`, conversation);
    } catch (e) {
      console.log(e);
    }
  });

  // socket.on(
  //   `conversation:update`,
  //   async ({ conversationId, currentUserId }) => {
  //     const foundConversation = await prisma.conversation.update({
  //       where: {
  //         id: conversationId,
  //       },
  //       data: {
  //         unreadMessageCountUser1:
  //           foundConversation?.userOneId === currentUserId
  //             ? 0
  //             : foundConversation?.unreadMessageCountUser1,
  //         unreadMessageCountUser2:
  //           foundConversation?.userTwoId === currentUserId
  //             ? 0
  //             : foundConversation?.unreadMessageCountUser2,
  //       },
  //     });
  //   }
  // );

  socket.on("call-disconnect", (userId) => {
    for (const roomId in rooms) {
      rooms[roomId] = rooms[roomId].filter((id) => id !== userId);
      socket.to(roomId).emit("user-disconnected", userId);
    }
  });
  socket.on("disconnect", () => {
    for (const roomId in rooms) {
      rooms[roomId] = rooms[roomId].filter((id) => id !== socket.id);
      socket.to(roomId).emit("user-disconnected", socket.id);
    }
  });
});

app.post("/api/signup", async (req, res) => {
  const { name, email, password } = req.body;

  try {
    const hashedPassword = await bcrypt.hash(password, 10);

    const existingUser = await prisma.user.findUnique({
      where: { email },
    });

    if (existingUser) {
      return res.status(400).json({ error: "User already exists" });
    }

    const user = await prisma.user.create({
      data: {
        username: name,
        email,
        password: hashedPassword,
      },
    });
    return res.status(201).json({ success: "User created" });
  } catch (error) {
    return res.status(500).json({ error: "Internal error" });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await prisma.user.findUnique({ where: { email } });

    if (!user) return res.status(400).json({ error: "User not found" });

    const validPassword = await bcrypt.compare(password, user.password);

    if (!validPassword)
      return res.status(400).json({ error: "Invalid credentials" });

    const token = jwt.sign(
      { userId: user.id, email: user.email },
      process.env.SECRET_KEY
    );

    return res
      .status(200)
      .json({ token, id: user?.id, profileImage: user?.profileImage });
  } catch (e) {
    console.log(e);
    return res.status(500).json({ error: "Internal error" });
  }
});

app.get("/api/post", async (req, res) => {
  try {
    const posts = await prisma.post.findMany({
      include: {
        author: {
          select: {
            username: true,
            createdAt: true,
            comments: true,
            likes: true,
          },
        },
      },
    });
    return res.status(200).json(posts);
  } catch (e) {
    return res.status(500).json({ message: "Internal error" });
  }
});

app.post("/api/post/create", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;

    const { content } = req.body;

    if (!content) {
      return res.status(400).json({ error: "Content is required" });
    }

    const post = await prisma.post.create({
      data: {
        content,
        authorId: userId,
      },
      include: {
        author: {
          select: {
            username: true,
            createdAt: true,
            comments: true,
            likes: true,
          },
        },
      },
    });

    return res.status(201).json({ success: "Post created", data: { post } });
  } catch (e) {
    return res.status(500).json({ error: "Internal error" });
  }
});

app.get("/api/users", async (req, res) => {
  try {
    const friends = await prisma.user.findMany({});

    return res.status(200).json({ data: { friends } });
  } catch (e) {
    return res.status(500).json({ error: "Internal error" });
  }
});

app.post("/api/send-friend-request", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { receiverId } = req.body;

    console.log(userId, receiverId);

    if (receiverId === userId) {
      return res.status(400).json({ error: "Cannot send request to self" });
    }

    const friendExist = await prisma.friendship.findFirst({
      where: {
        OR: [
          { userId, friendId: receiverId },
          { userId: receiverId, friendId: userId },
        ],
      },
    });

    if (friendExist) {
      return res.status(400).json({ error: "Friendship already exists" });
    }

    const friend = await prisma.friendRequest.create({
      data: {
        senderId: userId,
        receiverId,
      },
    });

    return res.status(200).json({ success: "Friend request sent" });
  } catch (e) {
    console.log(e);
    return res.status(500).json({ error: "Internal error" });
  }
});

app.post("/api/accept-friend-request", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { friendId } = req.body;

    const friend = await prisma.user.findUnique({
      where: { id: friendId },
    });

    if (!friend) return res.status(400).json({ error: "Friend not found" });

    const friendAlreadyExist = await prisma.friendship.findFirst({
      where: {
        OR: [
          { userId, friendId },
          { userId: friendId, friendId: userId },
        ],
      },
    });

    if (friendAlreadyExist) {
      return res.status(400).json({ error: "Already a friend" });
    }

    await prisma.friendship.create({
      data: {
        userId,
        friendId,
      },
    });

    const foundRequest = await prisma.friendRequest.findFirst({
      where: {
        OR: [
          { senderId: friendId, receiverId: userId },
          {
            senderId: userId,
            receiverId: friendId,
          },
        ],
      },
    });

    await prisma.friendRequest.delete({
      where: {
        id: foundRequest?.id,
      },
    });

    return res.status(201).json({ success: "Friend request accepted" });
  } catch (e) {
    return res.status(500).json({ error: "Internal error" });
  }
});

app.get("/api/received-requests", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const receivedRequests = await prisma.friendRequest.findMany({
      where: {
        receiverId: userId,
        status: "PENDING",
      },
      include: {
        sender: {
          select: {
            id: true,
            username: true,
            profileImage: true,
          },
        },
      },
    });
    return res.status(200).json({ data: receivedRequests });
  } catch (e) {
    return res.status(500).json({ error: "Internal error" });
  }
});

app.get("/api/sent-requests", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const sendRequests = await prisma.friendRequest.findMany({
      where: {
        senderId: userId,
        status: "PENDING",
      },
      include: {
        receiver: {
          select: {
            username: true,
            id: true,
          },
        },
        sender: {
          select: {
            username: true,
            id: true,
          },
        },
      },
    });
    return res.status(200).json({ data: sendRequests });
  } catch (e) {
    return res.status(500).json({ error: "Internal error" });
  }
});

app.delete("/api/sent-request", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { receiverId } = req.body;
    const sendRequests = await prisma.friendRequest.findFirst({
      where: {
        senderId: userId,
        receiverId,
        status: "PENDING",
      },
    });

    if (!sendRequests) {
      return res.status(400).json({ error: "Friend request not found" });
    }

    await prisma.friendRequest.delete({
      where: {
        senderId: userId,
        receiverId,
        status: "PENDING",
      },
    });
    return res.status(200).json({ success: "Friend request cancelled" });
  } catch (e) {
    return res.status(500).json({ error: "Internal error" });
  }
});

app.get("/api/friends", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;

    const friendships = await prisma.friendship.findMany({
      where: {
        OR: [{ userId }, { friendId: userId }],
      },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            profileImage: true,
          },
        },
        friend: {
          select: {
            id: true,
            username: true,
            profileImage: true,
          },
        },
      },
    });

    const friends = friendships.map((friendship) => {
      if (friendship.userId === userId) {
        return friendship.friend;
      } else {
        return friendship.user;
      }
    });

    return res.status(200).json({ data: friends });
  } catch (e) {
    return res.status(500).json({ error: "Internal error" });
  }
});

app.get("/api/conversations", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const conversations = await prisma.conversation.findMany({
      where: {
        OR: [{ userOneId: userId }, { userTwoId: userId }],
      },
      include: {
        messages: {
          where: { receiverId: userId },
        },
        userOne: true,
        userTwo: true,
      },
      orderBy: {
        messages: {
          _count: "desc",
        },
      },
    });

    return res.status(200).json({ data: conversations });
  } catch (e) {
    console.log(e);

    return res.status(500).json({ error: "Internal error" });
  }
});

app.post("/api/conversation", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { receiverId } = req.body;

    const existingConversation = await prisma.conversation.findFirst({
      where: {
        OR: [
          { userOneId: userId, userTwoId: receiverId },
          { userOneId: receiverId, userTwoId: userId },
        ],
      },
    });

    if (existingConversation) {
      return res.status(200).json({ data: existingConversation });
    }

    const conversation = await prisma.conversation.create({
      data: {
        userOneId: userId,
        userTwoId: receiverId,
        lastMessage: "",
      },
    });

    return res.status(201).json({ data: { conversation } });
  } catch (e) {
    console.log(e);
    return res.status(500).json({ error: "Internal error" });
  }
});

app.get(
  "/api/messages/:conversationId",
  authenticateToken,
  async (req, res) => {
    try {
      const userId = req.user.userId;
      const conversationId = req.params.conversationId;

      const messages = await prisma.message.findMany({
        where: {
          conversationId,
        },
        orderBy: {
          createdAt: "asc",
        },
      });

      const conversation = await prisma.conversation.findUnique({
        where: { id: conversationId },
      });

      if (!conversation) {
        return res.status(404).json({ error: "Conversation not found" });
      }

      const updateData = {};
      if (conversation.userOneId === userId) {
        updateData.unreadMessageCountUser1 = 0;
      } else if (conversation.userTwoId === userId) {
        updateData.unreadMessageCountUser2 = 0;
      }

      await prisma.conversation.update({
        where: { id: conversationId },
        data: updateData,
      });

      const groupedMessages = messages.reduce((groups, message) => {
        const date = message.createdAt.toISOString().split("T")[0];
        if (!groups[date]) {
          groups[date] = [];
        }
        groups[date].push(message);
        return groups;
      }, {});

      return res.status(200).json({ data: { groupedMessages } });
    } catch (e) {
      return res.status(500).json({ error: "Internal error" });
    }
  }
);

app.post("/api/message", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { receiverId, content } = req.body;

    if (!content) {
      return res.status(400).json({ error: "Content is required" });
    }

    let conversation = await prisma.conversation.findFirst({
      where: {
        OR: [
          {
            userOneId: userId,
            userTwoId: receiverId,
          },
          {
            userOneId: receiverId,
            userTwoId: userId,
          },
        ],
      },
    });

    if (!conversation) {
      conversation = await prisma.conversation.create({
        data: {
          userOneId: userId,
          userTwoId: receiverId,
        },
      });
    }

    const message = await prisma.message.create({
      data: {
        content,
        senderId: userId,
        receiverId,
        conversationId: conversation.id,
      },
    });

    return res.status(201).json({ success: "Message sent", data: { message } });
  } catch (e) {
    return res.status(500).json({ error: "Internal error" });
  }
});

server.listen(3000, () => {
  console.log("server running at http://localhost:3000");
});
