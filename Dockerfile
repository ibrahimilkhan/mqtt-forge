# Built with Node here, handed to the SDK stage as plain files; SkipFrontend below avoids npm there.
FROM node:22-alpine AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /source
COPY Directory.Build.props ./
COPY src/ src/
COPY --from=web /src/MQFaker.Api/wwwroot src/MQFaker.Api/wwwroot
RUN dotnet publish src/MQFaker.Api -c Release -p:SkipFrontend=true -o /app

FROM mcr.microsoft.com/dotnet/aspnet:10.0
WORKDIR /app
COPY --from=build /app ./
# Owned by APP_UID so a mounted volume stays writable under the non-root user.
RUN mkdir -p /data && chown $APP_UID /data
USER $APP_UID
EXPOSE 5169
ENTRYPOINT ["./MQFaker.Api"]
