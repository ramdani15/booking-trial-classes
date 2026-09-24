import { Module } from '@nestjs/common';
import { DbService } from './db.service';
import { ClassesController } from './classes.controller';

@Module({
  controllers: [ClassesController],
  providers: [DbService],
  exports: [DbService],
})
export class AppModule {}
