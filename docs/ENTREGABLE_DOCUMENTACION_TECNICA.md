# Documentación Técnica

**Módulo 3 - Reto: Diseñando Arquitecturas Resilientes**  
**Estudiante:** Santiago Torres Guevara (Grupo 4)  
**Fecha:** Diciembre 2025

---

## 1. Decisiones de Arquitectura

### 1.1 AWS Step Functions Express

**Decisión:** Usar Step Functions Express (Synchronous) como orquestador del Circuit Breaker.

**Justificación:**

- **Ejecución Síncrona:** El cliente espera respuesta inmediata. Express permite retornar el resultado directamente sin polling.
- **Orquestación Visual:** Los estados Choice y Catch mapean naturalmente al patrón Circuit Breaker, facilitando el mantenimiento.
- **Manejo de Errores Nativo:** El bloque `Catch` captura excepciones automáticamente y redirige el flujo sin código adicional.

**Alternativas descartadas:** Step Functions Standard (asíncrono, no apto para respuestas inmediatas), orquestación manual en Lambda (más complejo, difícil de mantener).

---

### 1.2 Amazon DynamoDB

**Decisión:** Usar DynamoDB con modo PAY_PER_REQUEST para persistir el estado del sistema.

**Justificación:**

- **Escalabilidad Automática:** Escala sin provisionar capacidad, ideal para picos de tráfico impredecibles.
- **Baja Latencia:** Lecturas/escrituras en milisegundos, crítico para decisiones de routing en tiempo real.
- **Operaciones Atómicas:** `UpdateExpression` garantiza incrementos/decrementos atómicos de contadores.

**Alternativas descartadas:** ElastiCache Redis (complejidad operativa), RDS (latencia mayor), Parameter Store (no soporta operaciones atómicas).

---

### 1.3 AWS Lambda con Node.js 20.x

**Decisión:** Usar Lambda como compute serverless con runtime Node.js 20.x.

**Justificación:**

- **Sin Gestión de Servidores:** Elimina overhead operativo, escala automáticamente.
- **Integración Nativa:** Se integra directamente con Step Functions, API Gateway y DynamoDB.
- **AWS SDK v3:** Runtime moderno con SDK v3 que ofrece mejor performance y tree-shaking.

---

### 1.4 Lambda Proxy (api-handler)

**Decisión:** Usar una Lambda intermediaria entre API Gateway y Step Functions.

**Justificación:**

- **Control de Respuesta:** Permite formatear la respuesta HTTP exactamente como espera el cliente.
- **Manejo de Errores:** Captura y transforma errores de Step Functions antes de retornarlos.
- **Headers CORS:** Configuración centralizada y consistente.

**Alternativas descartadas:** Integración directa API Gateway → Step Functions (menos control sobre formato de respuesta).

---

### 1.5 Recovery Points (Histéresis)

**Decisión:** Implementar un mecanismo de Histéresis basado en puntos de recuperación (consecutivos) en lugar de un simple umbral de tiempo o decremento de errores.

**Justificación:**

- **Estabilidad Matemática:** Estabilidad Matemática: A diferencia de una recuperación basada en tiempo, este enfoque exige una prueba empírica de estabilidad (10 éxitos genuinos) antes de promocionar el nivel.
- **Prevención de Oscilación (Flapping):** Evita el riesgo de que el sistema entre en un bucle de degradación-recuperación constante (L1 ↔ L2) ante cargas intermitentes.
- **Asimetría Intencional:** Degradación rápida (5 errores), recuperación lenta (10 éxitos).

---

## 2. Atributo de Calidad Más Importante

### Disponibilidad (Availability)

**Definición:** Capacidad del sistema para estar operativo y accesible cuando se necesita.

**¿Por qué fue priorizado?**

1. **Criticidad del Negocio:** Sistemas UltraSeguros S.A. maneja transacciones financieras donde cada minuto de inactividad representa pérdidas millonarias.

2. **Requisito Explícito del Reto:** El sistema debe "mantenerse operativo incluso en las peores circunstancias" y "seguir respondiendo" durante Operación Mínima.

3. **Confianza del Cliente:** Los usuarios confían en disponibilidad 24/7 para servicios críticos.

**Cómo se logra:**

| Mecanismo                  | Implementación                                             |
| -------------------------- | ---------------------------------------------------------- |
| Degradación Progresiva     | 3 niveles de servicio (Full → Degraded → Maintenance)      |
| Recuperación Automática    | Promoción tras 10 éxitos consecutivos                      |
| Tolerancia a Fallos        | Nivel 3 siempre responde (nunca retorna error de conexión) |
| Infraestructura Serverless | Lambda y DynamoDB escalan automáticamente                  |

**Trade-offs aceptados:**

- Funcionalidad reducida en niveles degradados
- Latencia adicional por verificación de estado
- Consistencia eventual durante transiciones

---

## 3. Diagrama de Arquitectura

### Diagrama de Componentes

![Diagrama de Arquitectura](./architecture-diagram.png)

**Componentes del Sistema:**

| Capa                   | Componente           | Descripción                             |
| ---------------------- | -------------------- | --------------------------------------- |
| API Layer              | API Handler (Lambda) | Punto de entrada, invoca Step Functions |
| Workflow Orchestration | State Machine        | Orquesta el Circuit Breaker             |
| Business Logic         | Service L1, L2       | Servicios por nivel de operación        |
| Business Logic         | Get System State     | Lee estado actual del sistema           |
| Business Logic         | Mutator              | Actualiza contadores y niveles          |
| Data Storage           | DynamoDB Table       | Persiste estado del Circuit Breaker     |
| Logging                | Log Group            | CloudWatch logs de ejecución            |

### Diagrama del Workflow (Step Functions)

![Diagrama del Workflow](./workflow-diagram.png)

**Flujo del Circuit Breaker:**

1. **GetSystemState**: Lee el nivel actual desde DynamoDB
2. **Router**: Decide la ruta según `$.systemState.currentLevel`
   - Level 1 → TryServiceL1 (con Catch para errores)
   - Level 2 → ServiceL2
   - Default → MaintenanceResponse
3. **MaintenanceResponse**: Si `$.error == true` → MaintenanceErrorResponse, sino → MaintenanceSuccessResponse
4. **RegisterSuccess/RegisterFailure**: Actualiza contadores en DynamoDB
5. **SuccessResponse/FailureResponse**: Formatea y retorna la respuesta

---

## 4. Tácticas de Arquitectura

### 4.1 Serverless Distributed Circuit Breaker

**Objetivo:** Detectar fallos y prevenir cascadas de errores en un entorno distribuido y sin estado.

**Implementación:**

- Estado Distribuido (No en Memoria): A diferencia de los Circuit Breakers tradicionales (como Hystrix o Resilience4j) que guardan el estado en la memoria del servidor, nuestra implementación externaliza el estado a DynamoDB. Esto permite que miles de ejecuciones concurrentes de Lambda compartan la misma "verdad" sobre la salud del sistema.
- Router Orquestado: El estado Choice en Step Functions actúa como el interruptor, desviando el tráfico antes de invocar servicios costosos.

**Resultado:** El sistema degrada sus capacidades de manera global y sincronizada en milisegundos, protegiendo los recursos backend.

---

### 4.2 Graceful Degradation

**Objetivo:** Mantener funcionalidad parcial cuando el sistema está bajo estrés.

**Implementación:**

- **Nivel 1 (Full):** Todas las capacidades, procesa normalmente
- **Nivel 2 (Degraded):** Ignora flag de error, siempre responde OK
- **Nivel 3 (Maintenance):** Responde con mensajes informativos sin procesar

**Resultado:** El sistema siempre responde al cliente, nunca falla silenciosamente.

---

### 4.3 Health Monitoring

**Objetivo:** Conocer el estado de salud del sistema en tiempo real.

**Implementación:**

- Contador `errorCount` en DynamoDB trackea errores acumulados
- Contador `recoveryPoints` trackea éxitos consecutivos
- Cada request actualiza los contadores atómicamente

**Resultado:** Decisiones de routing basadas en datos reales, no suposiciones.

---

### 4.4 Automatic Recovery (Self-Healing)

**Objetivo:** Recuperar el sistema automáticamente sin intervención manual.

**Implementación:**

- Tras 10 éxitos consecutivos genuinos, el sistema promociona un nivel
- L3 → L2 cuando `recoveryPoints >= 10`
- L2 → L1 cuando `recoveryPoints >= 10`
- La promoción resetea contadores

**Resultado:** El sistema se recupera solo cuando demuestra estabilidad.

---

### 4.5 Hysteresis (Histéresis)

**Objetivo:** Evitar oscilaciones rápidas entre niveles (flapping).

**Implementación:**

- **Degradación rápida:** 5 errores para L1→L2, 10 para L2→L3
- **Recuperación lenta:** 10 éxitos consecutivos para promocionar
- Cualquier error resetea el contador de recuperación

**Resultado:** Transiciones estables, no reactivas a picos momentáneos.

---

### Resumen de Tácticas

| Táctica              | Categoría           | Propósito                                 |
| -------------------- | ------------------- | ----------------------------------------- |
| Circuit Breaker      | Tolerancia a Fallos | Desviar tráfico ante errores              |
| Graceful Degradation | Disponibilidad      | Mantener respuesta con capacidad reducida |
| Health Monitoring    | Detectabilidad      | Conocer estado del sistema                |
| Automatic Recovery   | Auto-Sanación       | Recuperar sin intervención manual         |
| Hysteresis           | Estabilidad         | Evitar oscilaciones entre niveles         |
