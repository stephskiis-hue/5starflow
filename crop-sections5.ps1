Add-Type -AssemblyName System.Drawing

$srcPath = 'C:\Users\steph\Desktop\5starflow\.claude\screenshots\index-t2-desktop-10k.png'
$src = [System.Drawing.Bitmap]::new($srcPath)

Write-Host "Image size: $($src.Width) x $($src.Height)"

$crops = @(
  @{name="roi-calc"; y=6200; h=800},
  @{name="faq"; y=7000; h=800},
  @{name="cta-getstarted"; y=7800; h=800},
  @{name="pricing-cards-detail"; y=5200; h=900}
)

foreach ($c in $crops) {
  $h = [Math]::Min($c.h, $src.Height - $c.y)
  if ($h -le 0) { Write-Host "Skipping $($c.name) - out of bounds"; continue }
  $rect = [System.Drawing.Rectangle]::new(0, $c.y, $src.Width, $h)
  $bmp = $src.Clone($rect, $src.PixelFormat)
  $outPath = "C:\Users\steph\Desktop\5starflow\.claude\screenshots\detail-$($c.name).png"
  $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Host "Saved: $outPath"
}
$src.Dispose()
Write-Host "Done"
