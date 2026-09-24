import 'reflect-metadata';
import { join } from 'path';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { PORT, describeTarget } from './config';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // Four screens of plain HTML and fetch. No build step: every screen is a
  // call that could equally be made with curl.
  app.useStaticAssets(join(__dirname, '..', 'public'));
  await app.listen(PORT);
  console.log(`listening on http://localhost:${PORT}  (admin: /?admin=1)`);
  console.log(`database: ${describeTarget()}`);
}

bootstrap();
