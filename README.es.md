# html-editor

*[Read in English](README.md)*

Un editor visual para los archivos HTML que ya tenés en tu carpeta. Un solo
binario en Go, sin runtime, sin proyecto que configurar, sin base de datos: lo
ejecutás, se abre el navegador, editás la página como si fuera un documento,
apretás Guardar y el archivo del disco cambia.

```bash
cd micarpeta
html-editor miarchivo.html      # se abre el navegador en ese archivo
```

Cerrás la pestaña y el comando termina unos segundos después, como cualquier
herramienta de escritorio que se porte bien.

![El editor con la vista de código abierta y un enlace en edición](docs/screenshot.png)

## Para qué

Editar una página estática chica suele significar o escribir HTML a mano o meter
un constructor de sitios entero en el medio. `html-editor` está en el medio de
esos dos extremos: edita **el archivo que ya tenés**, en su lugar, respetando su
estructura, su hoja de estilos y sus imágenes. La carpeta sigue siendo
publicable tal cual está.

## Instalación

Necesita Go 1.21 o posterior.

```bash
git clone https://github.com/neitanod/html-editor.git
cd html-editor
make install          # compila y deja el symlink en ~/bin
```

`make install` crea un symlink, así que un `make build` posterior actualiza
también el comando instalado. Para instalarlo para todo el sistema:
`PREFIX=/usr/local/bin sudo make install`. O simplemente `make build` y poné el
binario donde te guste.

## Uso

```
html-editor [OPCIONES] [ARCHIVO]
```

| | |
|---|---|
| `html-editor` | edita `index.html` en la carpeta actual |
| `html-editor about.html` | edita ese archivo |
| `html-editor docs/guia.html` | edita un archivo en otra carpeta |

Si el archivo no existe se crea con el esqueleto completo: `<!DOCTYPE html>`,
`<html lang>`, un `<head>` con charset, viewport y título, y una hoja de estilos
por defecto legible.

### Opciones

| Flag | Qué hace |
|---|---|
| `--port <n>` | Puerto del servidor local (por defecto: el primero libre desde 8477) |
| `--host <dir>` | Dirección de bind (por defecto `127.0.0.1`, `0.0.0.0` con `--serve`) |
| `--serve` | Modo servidor: no abre el navegador ni se cierra solo — sirve para systemd |
| `--read-only` | Deshabilita todos los endpoints de escritura |
| `--no-browser` | Arranca normal pero sin abrir el navegador |
| `--dev <dir>` | Sirve la UI desde una carpeta de código en vez de la copia embebida |
| `--version` | Muestra la versión |

## Qué hace

**WYSIWYG que es la página de verdad.** El documento se sirve desde su propia
carpeta y se muestra en un iframe, así que su hoja de estilos, sus fuentes y sus
imágenes relativas se ven igual que cuando abrís el archivo directamente. Los
scripts del documento quedan aparcados mientras editás y se restauran intactos
al guardar.

**Vista dividida con el código.** Apretá *Código* (o `Ctrl+Shift+E`) para ver el
HTML generado al lado de la página, coloreado y editable. Aplicar empuja tus
cambios al lado visual, y el lado visual mantiene el código sincronizado
mientras escribís.

**Las imágenes pegadas se guardan, no se incrustan.** Pegás o soltás una imagen
y se escribe junto al documento con un nombre único, referenciada de forma
relativa (`<img src="foto.png">`), nunca como un data URL de varios megas.
Arrastrás los tiradores para redimensionarla: mantiene el aspect ratio salvo que
tengas *Shift* apretado.

**El contenido pegado de la web puede traerse sus imágenes.** Cuando lo que
pegás enlaza imágenes alojadas en otro sitio, el editor pregunta si lo querés
pegar tal cual o bajar esos recursos: se guardan junto al documento y se
enlazan de forma relativa, así la carpeta no depende de un sitio que no
controlás. Cubre `src`, `srcset`, `poster` y las `url()` de los estilos inline,
y el mismo comando está disponible para todo el documento desde el menú
contextual del fondo (*Descargar los recursos externos*). Un recurso que no se
puede bajar conserva su dirección original en vez de romper el resto.

**Enlaces que se pueden editar.** Hacés click en un enlace y aparece un panel
arriba o abajo —donde entre— con el texto legible, la dirección, un interruptor
de "pestaña nueva", un botón para *quitar el enlace* y otro para *abrirlo* en
otra pestaña.

**Click derecho en todo.** Copiar, cortar, duplicar, borrar, envolver en un
contenedor, seleccionar el padre, copiar el HTML, saltar al elemento en el
código y abrir sus propiedades. El click derecho en el fondo te da lo mismo para
`<body>`, más los metadatos del `<head>` y el elemento `<html>`.

**Propiedades sin saber HTML.** El inspector edita tipografías, tamaños,
colores, alineación, bordes, padding, márgenes, fondos, tamaño, posición y
efectos con controles de formulario de verdad, y al lado tenés la tabla cruda de
atributos para cuando sí sabés lo que estás haciendo. Los ajustes del documento
cubren el título, el charset, el viewport, la descripción, el autor, el favicon
y las etiquetas de Open Graph.

**Tablas como en un procesador de texto.** Se insertan con una grilla que se
previsualiza al pasar el mouse, y después podés agregar y borrar filas y
columnas, unir y dividir celdas, activar la fila de encabezado, redimensionar
columnas arrastrando y moverte entre celdas con Tab.

**Interfaz bilingüe.** Castellano e inglés, se cambia desde arriba a la derecha.

### Teclado

| | |
|---|---|
| `Ctrl+S` | Guardar |
| `Ctrl+Z` / `Ctrl+Y` | Deshacer / rehacer |
| `Ctrl+B` `Ctrl+I` `Ctrl+U` | Negrita, cursiva, subrayado |
| `Ctrl+K` | Insertar o editar un enlace |
| `Ctrl+Shift+E` | Mostrar u ocultar el código |
| `Ctrl+Shift+V` | Pegar como texto plano |
| `Ctrl+Enter` | Aplicar el código al documento |

## Seguridad de tus archivos

El primer guardado de cada sesión copia el archivo que encontró en el disco a
`<archivo>.bak`. Los guardados son atómicos: el contenido nuevo va a un archivo
temporal en la misma carpeta y se renombra sobre el original, así que un
guardado interrumpido nunca te trunca el documento. El servidor sólo lee y
escribe dentro de la carpeta del archivo que abriste, y escucha en `127.0.0.1`
salvo que le pidas otra cosa.

## Desarrollo

```
main.go        flags de la CLI, resolución del documento, arranque del servidor
server.go      tracking de clientes SSE, auto-shutdown, búsqueda de puerto
app.go         rutas HTTP: shell, /doc/, /api/document, /api/assets, /api/stream
document.go    creación del archivo, guardado atómico, aparcado de scripts
templates/     el shell del editor (embebido)
static/        módulos css y js (embebidos)
```

Todo es librería estándar de Go y JavaScript vanilla sin dependencias; el
frontend no tiene build. `make build` produce el binario único.

## Licencia

MIT — ver [LICENSE](LICENSE).
