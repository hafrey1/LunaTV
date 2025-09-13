/* eslint-disable no-console */
import { NextResponse } from 'next/server';

import { db } from '@/lib/db';
import { registerSchema } from '@/lib/schema';

export async function POST(request: Request) {
  // 检查是否允许注册
  if (process.env.NEXT_PUBLIC_ENABLE_REGISTER !== 'true') {
    return NextResponse.json({ error: '当前已关闭注册功能' }, { status: 403 });
  }

  try {
    const body = await request.json();

    // 验证请求数据
    const result = registerSchema.safeParse(body);
    if (!result.success) {
      return NextResponse.json(
        { error: '无效的用户名或密码' },
        { status: 400 }
      );
    }

    const { username, password } = result.data;

    // 检查用户名是否已存在
    const users = await db.getAllUsers();
    if (users.includes(username)) {
      return NextResponse.json({ error: '用户名已存在' }, { status: 400 });
    }

    // 注册用户
    await db.registerUser(username, password);

    return NextResponse.json({ message: '注册成功' }, { status: 201 });
  } catch (error) {
    console.error('注册失败:', error);
    return NextResponse.json(
      { error: '注册失败，请稍后重试' },
      { status: 500 }
    );
  }
}
