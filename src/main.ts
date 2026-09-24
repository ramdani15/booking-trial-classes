import 'reflect-metadata';
import { join } from 'path';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // Four screens of plain HTML and fetch. No build step: every screen is a
  // call that could equally be made with curl.
  app.useStaticAssets(join(__dirname, '..', 'public'));
  await app.listen(3000);
  console.log('listening on http://localhost:3000  (admin: /?admin=1)');
}

bootstrap();
