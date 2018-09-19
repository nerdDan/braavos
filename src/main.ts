import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ClientModule } from './client.module';

async function bootstrap() {
  const app = await NestFactory.create(ClientModule);
  app.useGlobalPipes(new ValidationPipe());
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Braavos Client')
      .setDescription('')
      .setSchemes('http', 'https')
      .setVersion('1.0')
      .addBearerAuth('Authorization', 'header')
      .build(),
  );
  SwaggerModule.setup('api', app, document);
  await app.listen(app.get('ConfigService').get('master').port);
}

bootstrap();
